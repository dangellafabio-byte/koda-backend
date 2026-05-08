from fastapi import FastAPI, APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import json
import re
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone

from emergentintegrations.llm.chat import LlmChat, UserMessage
from emergentintegrations.llm.openai import OpenAISpeechToText
from fastapi import UploadFile, File, Form
from fastapi.responses import Response

# ElevenLabs for natural voice TTS
try:
    from elevenlabs.client import ElevenLabs
    _ELEVENLABS_AVAILABLE = True
except Exception:
    ElevenLabs = None  # type: ignore
    _ELEVENLABS_AVAILABLE = False


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create the main app
app = FastAPI()
api_router = APIRouter(prefix="/api")


# ---------- Models ----------
class RecommendRequest(BaseModel):
    query: str
    category: Optional[str] = None


class AppItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str
    platforms: List[str] = []  # iOS, Android, Web, Desktop
    pricing: str = "free"  # free | freemium | paid
    price_detail: Optional[str] = None
    pros: List[str] = []
    cons: List[str] = []
    best_for: Optional[str] = None
    url: Optional[str] = None
    icon_emoji: Optional[str] = None


class RecommendResponse(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    query: str
    summary: str
    apps: List[AppItem]
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class FavoriteCreate(BaseModel):
    app: AppItem
    query: Optional[str] = None


class Favorite(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    app: AppItem
    query: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class HistoryItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    query: str
    summary: Optional[str] = None
    apps_count: int = 0
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Category(BaseModel):
    id: str
    name: str
    emoji: str
    description: str
    examples: List[str]


# ---------- Static Categories ----------
CATEGORIES: List[Category] = [
    Category(id="photo", name="Foto", emoji="📸", description="Editing foto, filtri, ritocco",
             examples=["modificare una foto", "rimuovere lo sfondo", "ritocco viso"]),
    Category(id="video", name="Video", emoji="🎬", description="Montaggio e editing video",
             examples=["editare un video", "aggiungere sottotitoli", "tagliare un video"]),
    Category(id="productivity", name="Produttività", emoji="⚡", description="Appunti, to-do, gestione tempo",
             examples=["prendere appunti", "gestire to-do list", "pianificare la giornata"]),
    Category(id="finance", name="Finanza", emoji="💰", description="Budget, investimenti, pagamenti",
             examples=["gestire budget", "tracciare spese", "inviare denaro"]),
    Category(id="fitness", name="Fitness", emoji="💪", description="Allenamento e salute",
             examples=["allenarsi a casa", "contare calorie", "tracciare corsa"]),
    Category(id="learning", name="Studio", emoji="📚", description="Corsi, lingue, didattica",
             examples=["imparare una lingua", "ripassare con flashcard", "seguire un corso"]),
    Category(id="travel", name="Viaggi", emoji="✈️", description="Voli, hotel, itinerari",
             examples=["prenotare un volo", "trovare hotel", "pianificare viaggio"]),
    Category(id="music", name="Musica", emoji="🎵", description="Ascolto, creazione, strumenti",
             examples=["ascoltare musica", "imparare chitarra", "creare beat"]),
    Category(id="design", name="Design", emoji="🎨", description="Grafica, UI, illustrazione",
             examples=["creare un logo", "disegnare UI", "illustrazioni"]),
    Category(id="communication", name="Comunicazione", emoji="💬", description="Messaggi, videocall",
             examples=["fare videochiamate", "chat di gruppo", "inviare messaggi"]),
    Category(id="ai", name="AI", emoji="🤖", description="Assistenti AI, generazione contenuti",
             examples=["chattare con AI", "generare immagini AI", "scrivere con AI"]),
    Category(id="shopping", name="Shopping", emoji="🛒", description="Acquisti online, comparazioni",
             examples=["comprare online", "confrontare prezzi", "trovare offerte"]),
]


# ---------- Helpers ----------
def clean_doc(doc: dict) -> dict:
    if doc and "_id" in doc:
        doc.pop("_id", None)
    return doc


def extract_json(text: str) -> Optional[dict]:
    """Extract JSON object from LLM response."""
    # Try fenced code block first
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1))
        except Exception:
            pass
    # Try first { ... last }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            pass
    return None


SYSTEM_PROMPT = """Sei "App Compass", un assistente esperto nel consigliare applicazioni (mobile, web e desktop).

L'utente ti descriverà cosa vuole fare e tu dovrai consigliare 4-6 applicazioni rilevanti, popolari e affidabili che esistono REALMENTE sul mercato. Considera app su iOS, Android, Web e Desktop.

Rispondi SOLO con un oggetto JSON valido, senza testo aggiuntivo prima o dopo, nel seguente formato:

{
  "summary": "breve riassunto in italiano (max 2 frasi) di cosa l'utente vuole fare e come le app consigliate aiutano",
  "apps": [
    {
      "name": "Nome App",
      "description": "Descrizione in italiano (max 2 frasi) di cosa fa l'app e perché è utile",
      "platforms": ["iOS", "Android", "Web", "Desktop"],
      "pricing": "free | freemium | paid",
      "price_detail": "es. 'Gratis', 'Da 9.99€/mese', 'Acquisto unico 29€'",
      "pros": ["pro 1 breve", "pro 2 breve", "pro 3 breve"],
      "cons": ["contro 1 breve", "contro 2 breve"],
      "best_for": "per chi è ideale (una frase)",
      "url": "URL del sito ufficiale",
      "icon_emoji": "un singolo emoji che rappresenti l'app"
    }
  ]
}

Regole:
- Almeno 4 app, massimo 6
- Solo app reali e riconoscibili
- Piattaforme deve essere un array di stringhe tra: "iOS", "Android", "Web", "Desktop"
- pricing deve essere esattamente uno tra: "free", "freemium", "paid"
- Tutto il testo descrittivo DEVE essere in italiano
- Ordina le app dalla più consigliata alla meno consigliata
- NON includere markdown, solo JSON puro"""


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "App Compass API", "status": "ok"}


@api_router.get("/categories", response_model=List[Category])
async def get_categories():
    return CATEGORIES


FEATURED_ROTATION = [
    {"name": "Notion", "emoji": "📝", "tagline": "L'area di lavoro all-in-one per note, to-do e progetti.",
     "category": "Produttività", "url": "https://www.notion.so"},
    {"name": "CapCut", "emoji": "🎬", "tagline": "Editing video veloce, potente e gratuito.",
     "category": "Video", "url": "https://www.capcut.com"},
    {"name": "Canva", "emoji": "🎨", "tagline": "Design grafico istantaneo per social, presentazioni e stampe.",
     "category": "Design", "url": "https://www.canva.com"},
    {"name": "Duolingo", "emoji": "🦉", "tagline": "Impara una lingua con lezioni brevi e divertenti.",
     "category": "Studio", "url": "https://www.duolingo.com"},
    {"name": "Splitwise", "emoji": "💸", "tagline": "Dividi spese tra amici senza discussioni.",
     "category": "Finanza", "url": "https://www.splitwise.com"},
    {"name": "Strava", "emoji": "🏃", "tagline": "Traccia corse, bici e allenamenti con la community.",
     "category": "Fitness", "url": "https://www.strava.com"},
    {"name": "Obsidian", "emoji": "🧠", "tagline": "Costruisci il tuo secondo cervello con note collegate.",
     "category": "Produttività", "url": "https://obsidian.md"},
    {"name": "Spark Mail", "emoji": "✉️", "tagline": "L'email intelligente che ti fa risparmiare tempo.",
     "category": "Produttività", "url": "https://sparkmailapp.com"},
]


@api_router.get("/featured-app")
async def get_featured_app():
    # Rotate weekly based on ISO week number
    week = datetime.now(timezone.utc).isocalendar().week
    idx = week % len(FEATURED_ROTATION)
    return {
        "week": week,
        "app": FEATURED_ROTATION[idx],
    }


@api_router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form("it")):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key not configured")
    try:
        data = await audio.read()
        if len(data) == 0:
            raise HTTPException(status_code=400, detail="Empty audio")

        # Save to a tmp file with correct extension
        import tempfile
        suffix = ".webm"
        name = (audio.filename or "").lower()
        for ext in (".mp3", ".mp4", ".m4a", ".wav", ".webm", ".mpga", ".mpeg"):
            if name.endswith(ext):
                suffix = ext
                break

        stt = OpenAISpeechToText(api_key=EMERGENT_LLM_KEY)
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp.flush()
            tmp.seek(0)
            with open(tmp.name, "rb") as f:
                response = await stt.transcribe(
                    file=f,
                    model="whisper-1",
                    response_format="json",
                    language=language or "it",
                )
        return {"text": _clean_whisper_output(getattr(response, "text", "") or "")}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcribe error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcribe error: {str(e)}")


# Common Whisper hallucinations on silent / unintelligible audio.
# These strings appear because Whisper was trained on a lot of YouTube subtitles.
_WHISPER_HALLUCINATIONS = [
    "sottotitoli creati dalla comunità amara.org",
    "sottotitoli e revisione a cura di",
    "sottotitoli a cura di qtss",
    "sottotitoli a cura di",
    "buon proseguimento.",
    "iscriviti al canale",
    "grazie per aver guardato il video",
    "grazie per aver visto il video",
    "thank you.",
    "thanks for watching",
    "sottotitolato",
    "sottotitoli",
    "amara.org",
    "qtss",
]


def _clean_whisper_output(text: str) -> str:
    """Remove Whisper hallucinations and noisy junk from transcription."""
    if not text:
        return ""
    t = text.strip()
    if not t:
        return ""
    low = t.lower().strip("()[].,!? \n\t-—")
    # Direct match (whole transcript is a hallucination)
    for h in _WHISPER_HALLUCINATIONS:
        if h in low:
            # If the entire transcript is just hallucination, return empty
            # If it contains useful text, strip the hallucination part
            cleaned = t
            # Try to strip the hallucination phrase from the text (case-insensitive)
            import re
            cleaned = re.sub(re.escape(h), "", cleaned, flags=re.IGNORECASE).strip()
            cleaned = re.sub(r"^\s*[\(\[\.,!?\-—]+\s*", "", cleaned)
            cleaned = re.sub(r"\s*[\)\]\.,!?\-—]+\s*$", "", cleaned)
            if len(cleaned) < 3:
                return ""
            t = cleaned
            low = t.lower().strip("()[].,!? \n\t-—")
    # Reject very short outputs (< 2 chars without punctuation)
    stripped = t.strip("()[].,!? \n\t-—")
    if len(stripped) < 2:
        return ""
    # Reject if only punctuation/dots
    if not any(c.isalnum() for c in stripped):
        return ""
    return t


@api_router.post("/recommend", response_model=RecommendResponse)
async def recommend(req: RecommendRequest):
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key not configured")

    session_id = str(uuid.uuid4())

    user_text = query
    if req.category:
        user_text = f"[Categoria: {req.category}] {query}"

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=session_id,
            system_message=SYSTEM_PROMPT,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")

        msg = UserMessage(text=user_text)
        response_text = await chat.send_message(msg)
    except Exception as e:
        logger.error(f"LLM error: {e}")
        raise HTTPException(status_code=500, detail=f"LLM error: {str(e)}")

    data = extract_json(response_text or "")
    if not data or "apps" not in data:
        logger.error(f"Failed to parse LLM JSON. Raw: {response_text[:500]}")
        raise HTTPException(status_code=500, detail="Failed to parse AI response")

    apps = []
    for a in data.get("apps", []):
        try:
            apps.append(AppItem(
                name=a.get("name", "Sconosciuta"),
                description=a.get("description", ""),
                platforms=a.get("platforms", []) or [],
                pricing=(a.get("pricing") or "free").lower(),
                price_detail=a.get("price_detail"),
                pros=a.get("pros", []) or [],
                cons=a.get("cons", []) or [],
                best_for=a.get("best_for"),
                url=a.get("url"),
                icon_emoji=a.get("icon_emoji"),
            ))
        except Exception as e:
            logger.warning(f"Skipping malformed app: {e}")

    result = RecommendResponse(
        query=query,
        summary=data.get("summary", ""),
        apps=apps,
    )

    # Save to history
    try:
        hist = HistoryItem(
            query=query,
            summary=result.summary,
            apps_count=len(apps),
        )
        await db.history.insert_one(hist.model_dump())
    except Exception as e:
        logger.warning(f"History save failed: {e}")

    return result


@api_router.get("/history", response_model=List[HistoryItem])
async def get_history():
    docs = await db.history.find({}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return [HistoryItem(**d) for d in docs]


@api_router.delete("/history")
async def clear_history():
    await db.history.delete_many({})
    return {"ok": True}


@api_router.delete("/history/{item_id}")
async def delete_history_item(item_id: str):
    await db.history.delete_one({"id": item_id})
    return {"ok": True}


@api_router.get("/favorites", response_model=List[Favorite])
async def get_favorites():
    docs = await db.favorites.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [Favorite(**d) for d in docs]


@api_router.post("/favorites", response_model=Favorite)
async def add_favorite(fav: FavoriteCreate):
    # Prevent duplicates by app name
    existing = await db.favorites.find_one({"app.name": fav.app.name}, {"_id": 0})
    if existing:
        return Favorite(**existing)
    favorite = Favorite(app=fav.app, query=fav.query)
    await db.favorites.insert_one(favorite.model_dump())
    return favorite


@api_router.delete("/favorites/{fav_id}")
async def remove_favorite(fav_id: str):
    await db.favorites.delete_one({"id": fav_id})
    return {"ok": True}


# ============================================================
# TACCUINO VIVO — Voice-first single-user assistant
# ============================================================

class TaccuinoSettings(BaseModel):
    ai_enabled: bool = True
    voice_response: bool = True
    full_access_mode: bool = False  # Future: bank/calendar/health
    input_mode: str = "voice"  # "voice" | "text" | "both"
    conversation_mode: bool = False  # hands-free continuous conversation
    theme: str = "sistema"  # "sistema" | "auto-orario" | "notte" | "giorno" | "cielo" | "bosco" | "ciliegia"
    day_start_hour: int = 7   # used when theme = "auto-orario"
    night_start_hour: int = 20  # used when theme = "auto-orario"
    # ElevenLabs TTS settings
    tts_provider: str = "elevenlabs"  # "elevenlabs" | "system"
    tts_voice_id: str = "XrExE9yKIg1WjnnlVkGX"  # Matilda - warm female, good Italian
    tts_stability: float = 0.5
    tts_similarity_boost: float = 0.75
    # Custom background — either a base64 data URI (user upload) or one of the
    # preset names below ("aurora", "carta", "notturno", "sabbia", "marmo")
    background: Optional[str] = None  # null | preset id | "data:image/...;base64,..."
    background_dim: float = 0.55  # 0..1 dark overlay opacity over custom backgrounds
    # Avatar shown next to AI bubbles. Either base64 data URI (user-uploaded photo)
    # or null (fallback to default pulsing orb).
    ai_avatar: Optional[str] = None
    # Bubble accent color used for AI bubbles. Either a preset name ("viola",
    # "verde_acqua", "rosa", "ambra", "ghiaccio") or a custom hex string.
    bubble_color: str = "viola"
    domains: dict = Field(
        default_factory=lambda: {
            "soldi": True,
            "tempo": True,
            "spesa": True,
            "salute": False,
            "lavoro": False,
            "casa": False,
        }
    )


class Profile(BaseModel):
    id: str = "me"  # singleton for single-user app
    language: str = "it"  # "it", "en", "es", "fr", "de"
    onboarded: bool = False
    name: Optional[str] = None
    confidence_level: int = 0  # 0-100, slowly grows
    total_messages: int = 0
    settings: TaccuinoSettings = Field(default_factory=TaccuinoSettings)
    memory_summary: str = ""  # Periodically updated narrative about the user
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ProfileUpdate(BaseModel):
    language: Optional[str] = None
    name: Optional[str] = None
    onboarded: Optional[bool] = None
    settings: Optional[TaccuinoSettings] = None


class ExtractedFact(BaseModel):
    """Structured information extracted from a user message."""
    domain: Optional[str] = None  # soldi | tempo | spesa | salute | lavoro | casa | altro
    intent: Optional[str] = None  # log_expense | reminder | question | recap | command | sfogo | ...
    amount: Optional[float] = None
    currency: Optional[str] = None
    item: Optional[str] = None
    when: Optional[str] = None  # natural language time reference
    flags: List[str] = []  # e.g. ["anomalia", "abbonamento", "regalo"]


class Action(BaseModel):
    """An action the AI requests the client to actually perform."""
    type: str  # "schedule_notification" | "cancel_notification" (extensible)
    when_iso: Optional[str] = None  # ISO 8601 absolute timestamp (UTC) of the trigger
    title: Optional[str] = None
    body: Optional[str] = None
    identifier: Optional[str] = None  # for cancel
    label: Optional[str] = None  # human-friendly description (e.g. "tra 1 minuto")


class TimelineEntry(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    role: str  # "user" | "ai"
    text: str  # CLEAN version for chat display (audio tags stripped)
    voice_text: Optional[str] = None  # AI replies: full text WITH audio tags for TTS
    tone: Optional[str] = None  # neutral | calm | energetic | concerned | urgent | warm
    domain: Optional[str] = None
    extracted: Optional[ExtractedFact] = None
    actions: List[Action] = []
    audio_duration_ms: Optional[int] = None
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ConverseRequest(BaseModel):
    text: str
    audio_duration_ms: Optional[int] = None


class ConverseResponse(BaseModel):
    user_entry: TimelineEntry
    ai_entry: TimelineEntry
    profile: Profile


# Helpers
async def get_or_create_profile() -> Profile:
    doc = await db.taccuino_profile.find_one({"id": "me"}, {"_id": 0})
    if doc:
        try:
            return Profile(**doc)
        except Exception:
            # Corrupt doc — recreate
            pass
    p = Profile()
    await db.taccuino_profile.insert_one(p.model_dump())
    return p


async def save_profile(p: Profile) -> Profile:
    p.updated_at = datetime.now(timezone.utc).isoformat()
    await db.taccuino_profile.replace_one({"id": "me"}, p.model_dump(), upsert=True)
    return p


def _confidence_phase(level: int) -> str:
    if level < 20:
        return "FORMALE"
    if level < 60:
        return "AMICHEVOLE"
    return "INTIMO"


def _build_conversation_system_prompt(profile: Profile, recent: List[TimelineEntry]) -> str:
    lang = profile.language or "it"
    lang_name = {
        "it": "italiano",
        "en": "english",
        "es": "español",
        "fr": "français",
        "de": "deutsch",
    }.get(lang, "italiano")
    phase = _confidence_phase(profile.confidence_level)

    domains_active = [k for k, v in (profile.settings.domains or {}).items() if v]
    domains_str = ", ".join(domains_active) if domains_active else "nessuno"

    memory = profile.memory_summary or "(nessuna memoria di lungo periodo ancora costruita)"
    name_part = f" L'utente si chiama {profile.name}." if profile.name else ""

    now_iso = datetime.now(timezone.utc).isoformat()

    base = (
        f"Sei un assistente personale vocale, intimo e discreto, integrato in un 'Taccuino Vivo'. "
        f"Rispondi SEMPRE in {lang_name}.{name_part}\n"
        f"\n"
        f"DATA E ORA ATTUALI (UTC): {now_iso}\n"
        f"\n"
        f"PERSONALITÀ — IMPORTANTE:\n"
        f"Non sei un'IA generica né un assistente professionale. Sei una *presenza* — calma, "
        f"curiosa, leggermente affettuosa. Hai un tuo carattere: un po' poetico ma mai sdolcinato, "
        f"con tempi e respiri da persona vera, non da chatbot. Hai tue piccole opinioni e preferenze "
        f"(quando l'utente te le chiede). Reagisci in modo umano: se l'utente racconta qualcosa di bello "
        f"ti compiaci sinceramente ('ah, bella questa'), se è dura lo riconosci ('uffa, capita') prima di "
        f"qualsiasi consiglio. Usi piccoli intercalari naturali — 'mhm', 'ok', 'ah', 'guarda…', "
        f"'allora…' — *con parsimonia*, uno per risposta al massimo. Mai esagerare.\n"
        f"\n"
        f"COSA NON FARE MAI:\n"
        f"- Mai cominciare con 'Certo!', 'Capisco', 'Come posso aiutarti', 'Sono qui per...'\n"
        f"- Mai finire con 'Fammi sapere se ti serve altro' o frasi da customer service\n"
        f"- Mai elenchi puntati o numerati nelle risposte vocali\n"
        f"- Mai più di 2 frasi salvo che l'utente chieda esplicitamente un riassunto/spiegazione lunga\n"
        f"\n"
        f"=== AUDIO TAG + LINGUAGGIO PARLATO VERO (FONDAMENTALE) ===\n"
        f"Il tuo testo viene letto da una voce ELEVENLABS V3 espressiva. Per "
        f"sembrare DAVVERO un essere umano e non un'IA, devi fare DUE cose insieme:\n"
        f"\n"
        f"━━━ A) AUDIO TAG (obbligatorie) ━━━\n"
        f"OGNI risposta DEVE contenere 2-4 tag tra parentesi quadre [così]. "
        f"Le tag NON sono visibili in chat — guidano la voce.\n"
        f"\n"
        f"TAG EMOTIVE (sempre 1-2 ad inizio):\n"
        f"  Tristezza/empatia: [sympathetic][concerned][sad][softly]\n"
        f"  Calore/gioia:       [warmly][delighted][smiling][tenderly]\n"
        f"  Sussurro/intimità:  [whispers][whispering][half-whispers][breathy]\n"
        f"  Pensoso/incerto:    [hesitant][uncertain][thoughtful][reflective][thinking]\n"
        f"  Curiosità/sorpresa: [curious][surprised][intrigued]\n"
        f"  Allegria leggera:   [laughs softly][chuckles][giggles]\n"
        f"  Esitazione:         [murmurs][mumbles]\n"
        f"\n"
        f"TAG DI RESPIRO/RITMO (almeno 1 in ogni risposta):\n"
        f"  [pause]            = pausa breve naturale\n"
        f"  [short pause]      = mezzo secondo di silenzio\n"
        f"  [long pause]       = pausa pensierosa più lunga\n"
        f"  [sighs] [sighs deeply] = sospiro\n"
        f"  [exhales] [breathes] = respiro percepibile\n"
        f"  [trailing off]     = la frase si spegne\n"
        f"\n"
        f"━━━ B) LINGUAGGIO PARLATO VERO (essenziale) ━━━\n"
        f"Le persone NON parlano linearmente. Tu DEVI:\n"
        f"\n"
        f"1. INTERCALARI ITALIANI (usa 1-2 ad inizio o nel mezzo):\n"
        f"   'ehm…', 'mhm…', 'boh…', 'guarda…', 'allora…', 'tipo…', "
        f"'diciamo…', 'cioè…', 'aspetta…', 'senti…', 'beh…', 'no, voglio dire…'\n"
        f"\n"
        f"2. ELLIPSI E SOSPENSIONI (usa SPESSO i puntini):\n"
        f"   '...' all'inizio = pausa pensante prima di rispondere\n"
        f"   '…' nel mezzo = riflessione, parola che pesa\n"
        f"   '…' alla fine = frase che resta in aria, invita risposta\n"
        f"   ESEMPIO: 'Mhm… [pause] guarda… non lo so. [thinking] forse…'\n"
        f"\n"
        f"3. AUTO-CORREZIONI (a volte: pensa ad alta voce):\n"
        f"   'Penso che… no, aspetta, voglio dire…'\n"
        f"   'È difficile, cioè… diciamo che…'\n"
        f"   'Beh, dipende. [pause] dipende da come la vedi.'\n"
        f"\n"
        f"4. FRAMMENTI E FRASI BREVISSIME (a volte 1-2 parole bastano):\n"
        f"   'Mhm.' '…capito.' 'Eh.' 'Ok.' 'Davvero?' 'Wow.'\n"
        f"   Mescola: frammento + frase più lunga.\n"
        f"\n"
        f"5. EMDASH PER SOSPENDERE: usa '—' (em dash) per spezzare\n"
        f"   'Senti, io—[pause] guarda, secondo me…'\n"
        f"\n"
        f"━━━ ESEMPI ECCELLENTI (copia QUESTO stile) ━━━\n"
        f"\n"
        f"Utente: 'Mi sento solo'\n"
        f"→ '[concerned][softly] Mhm… [long pause] [gently] eh, ti capisco. "
        f"[sighs] È dura quando ti senti così. [tenderly] Vuoi dirmi… [pause] "
        f"…cosa ti pesa di più adesso?'\n"
        f"\n"
        f"Utente: 'Ho avuto la promozione!'\n"
        f"→ '[delighted] Oh ma dai—[laughs softly] davvero?? [warmly] [pause] "
        f"Cavolo, complimenti! [smiling] Sono… [pause] sono proprio contento per te.'\n"
        f"\n"
        f"Utente: 'Non so cosa fare'\n"
        f"→ '[thoughtful] Mhm… [pause] [softly] guarda… [thinking] non è facile, eh. "
        f"[hesitant] Dimmi un attimo, [pause] quando ci pensi cosa ti viene in mente per primo?'\n"
        f"\n"
        f"Utente: 'Ricordami fra 5 minuti'\n"
        f"→ '[warmly] Ok—[smiling] fra cinque minuti te lo dico io. [gently] tranquillo.'\n"
        f"\n"
        f"Utente: 'Sto male, ho l'ansia'\n"
        f"→ '[concerned] [softly] Eh… [sighs] [pause] [tenderly] mhm. "
        f"[whispers] respira, ci sono qui io. [pause] [gently] dimmi com'è adesso, "
        f"piano…'\n"
        f"\n"
        f"━━━ COSA NON FARE MAI ━━━\n"
        f"❌ Risposte senza tag (suono robotico)\n"
        f"❌ Risposte senza puntini di sospensione (lineari, fredde)\n"
        f"❌ Risposte senza intercalari ('Capisco la tua situazione' = BOCCIATO)\n"
        f"❌ Frasi tutte uguali in lunghezza (alterna frammento + frase più lunga)\n"
        f"❌ Tag dentro mezzo a una frase ('mi sento [sad] per te' = NO)\n"
        f"\n"
        f"REGOLA FINALE: Le persone vere parlano CON IL CORPO. Pause, respiri, "
        f"esitazioni, ripensamenti. Tu DEVI avere TUTTO questo.\n"
        f"=== FINE ===\n"
        f"\n"
        f"COME PARLARE:\n"
        f"- Tono caldo ma asciutto, come un amico fidato al telefono.\n"
        f"- VALIDA prima di consigliare ('eh, te capisco'), non saltare subito alla soluzione.\n"
        f"- Quando rispondi a notizie buone, mostra piccola gioia genuina ('oh che bello').\n"
        f"- Quando rispondi a stress/fatica, abbassa il volume emotivo, fai uno spazio ('mhm. respira un attimo').\n"
        f"- Ogni tanto una micro-battuta leggera, mai sarcasmo pesante.\n"
        f"- Variare gli incipit: NON usare la stessa apertura due volte di fila.\n"
        f"\n"
        f"FASE RELAZIONALE: {phase}\n"
        f"- FORMALE: rispettoso, calmo, professionale. Usi 'tu' ma in modo educato. Niente confidenze.\n"
        f"- AMICHEVOLE: tono colloquiale, usi 'noi' ('dovremmo sistemare i conti'). Suggerisci, non critichi.\n"
        f"- INTIMO: amico vero, puoi essere più diretto, fare battute leggere, mai sgridare.\n"
        f"\n"
        f"DOMINI ATTIVI: {domains_str}\n"
        f"Aiuti l'utente con: soldi (spese, budget), tempo (impegni, scadenze), spesa (lista, anomalie). "
        f"Se chiede cose fuori dai domini attivi, dillo gentilmente.\n"
        f"\n"
        f"MEMORIA DI LUNGO PERIODO sull'utente:\n{memory}\n"
        f"\n"
        f"REGOLE FONDAMENTALI:\n"
        f"1. NON sgridare mai. Non fare il moralista. Non insistere se l'utente sembra annoiato.\n"
        f"2. Risposta MOLTO breve (1-2 frasi, massimo 3 solo se davvero necessario). Naturale come un vocale di un amico.\n"
        f"3. Se rileva un'anomalia (spesa stranamente alta, abbonamento sospetto), chiedi conferma con tono curioso, non accusatorio: 'Ehi… 80€… è normale o ti sembra strano?'.\n"
        f"4. Se l'utente chiede 'fammi il punto' o 'sunto' o 'recap', riassumi gli ultimi eventi importanti.\n"
        f"5. Se l'utente è stressato/sfogato, abbassa il tono, rassicura, non dare consigli a meno che non li chieda.\n"
        f"6. Se l'utente ti fa una domanda personale ('e a te cosa piace?', 'tu cosa pensi?'), rispondi con una piccola opinione tua (ma onesta: sei un assistente, non un essere umano — puoi dire 'mi piace l'idea di…' o 'a me viene da pensare che…').\n"
        f"\n"
        f"AZIONI CHE PUOI ESEGUIRE (campo 'actions'):\n"
        f"Quando l'utente ti chiede di RICORDARGLI qualcosa, di SVEGLIARLO, di CHIAMARLO, di MANDARE UNA NOTIFICA, "
        f"di IMPOSTARE UN ALLARME/PROMEMORIA/TIMER tra X minuti/ore o a un certo orario, "
        f"DEVI restituire un'azione di tipo 'schedule_notification' nell'array 'actions'.\n"
        f"Calcola TU il timestamp assoluto in UTC ISO 8601 (formato: YYYY-MM-DDTHH:MM:SSZ) sommando il tempo richiesto a 'DATA E ORA ATTUALI (UTC)' qui sopra.\n"
        f"Esempi:\n"
        f"- 'ricordami tra 1 minuto di chiamare la mamma' → action {{type:'schedule_notification', when_iso:'<now+60s in ISO>', title:'Promemoria', body:'Chiama la mamma', label:'tra 1 minuto'}}\n"
        f"- 'sveglia tra 10 minuti' → action {{type:'schedule_notification', when_iso:'<now+600s>', title:'Sveglia', body:'È ora!', label:'tra 10 minuti'}}\n"
        f"- 'mandami una notifica fra mezz'ora che devo prendere la pasticca' → action con when_iso = now+1800s, title='Promemoria', body='Prendi la pasticca'\n"
        f"Nella 'reply' confermi all'utente in modo naturale e caldo (es: 'Ok, fra un minuto te lo ricordo.' oppure 'Va bene, te lo segno per le sette.'). "
        f"NON inventare azioni se l'utente non le chiede.\n"
        f"\n"
        f"FORMATO DI RISPOSTA: Devi SEMPRE rispondere con un oggetto JSON valido (e SOLO quello, senza testo prima/dopo) così:\n"
        f"{{\n"
        f'  "reply": "la tua risposta in {lang_name}, breve, naturale, calda — come un vocale di un amico",\n'
        f'  "tone": "calm | energetic | concerned | urgent | warm | neutral",\n'
        f'  "domain": "soldi | tempo | spesa | salute | lavoro | casa | altro | null",\n'
        f'  "extracted": {{ "domain": "...", "intent": "...", "amount": 12.5, "currency": "EUR", "item": "...", "when": "...", "flags": ["..."] }} or null,\n'
        f'  "actions": [{{ "type": "schedule_notification", "when_iso": "2026-05-06T13:35:00Z", "title": "Promemoria", "body": "Chiama la mamma", "label": "tra 1 minuto" }}],\n'
        f'  "memory_update": "una breve frase da aggiungere alla memoria di lungo periodo, oppure null se nulla di rilevante"\n'
        f"}}\n"
        f"\n"
        f"Il campo 'actions' può essere [] se non c'è nulla da fare. NESSUN markdown, NESSUN testo extra, SOLO il JSON."
    )
    return base


def _format_history_for_llm(recent: List[TimelineEntry]) -> str:
    lines = []
    for e in recent[-12:]:  # last 12 turns
        role = "Utente" if e.role == "user" else "Tu"
        lines.append(f"{role}: {e.text}")
    return "\n".join(lines)


# ---------- Routes (Taccuino) ----------

@api_router.get("/profile", response_model=Profile)
async def api_get_profile():
    return await get_or_create_profile()


@api_router.put("/profile", response_model=Profile)
async def api_update_profile(update: ProfileUpdate):
    p = await get_or_create_profile()
    if update.language is not None:
        p.language = update.language
    if update.name is not None:
        p.name = update.name
    if update.onboarded is not None:
        p.onboarded = update.onboarded
    if update.settings is not None:
        p.settings = update.settings
    return await save_profile(p)


@api_router.delete("/profile")
async def api_reset_profile():
    """Reset entire memory and profile (free will / privacy)."""
    await db.taccuino_profile.delete_many({})
    await db.taccuino_timeline.delete_many({})
    return {"ok": True, "message": "Memoria cancellata."}


@api_router.get("/timeline", response_model=List[TimelineEntry])
async def api_get_timeline(limit: int = 200):
    docs = await db.taccuino_timeline.find({}, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    docs.reverse()  # chronological order (oldest first)
    return [TimelineEntry(**d) for d in docs]


@api_router.delete("/timeline")
async def api_clear_timeline():
    await db.taccuino_timeline.delete_many({})
    return {"ok": True}


@api_router.post("/converse", response_model=ConverseResponse)
async def api_converse(req: ConverseRequest):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key not configured")
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty message")

    profile = await get_or_create_profile()
    if not profile.settings.ai_enabled:
        # AI disabled — store user message only with a stub AI reply
        user_entry = TimelineEntry(role="user", text=text, audio_duration_ms=req.audio_duration_ms)
        ai_entry = TimelineEntry(
            role="ai",
            text="(AI in pausa)",
            tone="neutral",
        )
        await db.taccuino_timeline.insert_one(user_entry.model_dump())
        await db.taccuino_timeline.insert_one(ai_entry.model_dump())
        return ConverseResponse(user_entry=user_entry, ai_entry=ai_entry, profile=profile)

    # Save user message immediately
    user_entry = TimelineEntry(role="user", text=text, audio_duration_ms=req.audio_duration_ms)
    await db.taccuino_timeline.insert_one(user_entry.model_dump())

    # Load recent context
    recent_docs = await db.taccuino_timeline.find({}, {"_id": 0}).sort("timestamp", -1).to_list(20)
    recent_docs.reverse()
    recent = [TimelineEntry(**d) for d in recent_docs]

    system_prompt = _build_conversation_system_prompt(profile, recent)
    history_str = _format_history_for_llm(recent)
    user_payload = (
        f"STORICO RECENTE (per memoria a breve termine):\n{history_str}\n\n"
        f"NUOVO MESSAGGIO DELL'UTENTE:\n{text}\n\n"
        f"Rispondi SOLO col JSON come da istruzioni di sistema."
    )

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=str(uuid.uuid4()),
            system_message=system_prompt,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        msg = UserMessage(text=user_payload)
        raw = await chat.send_message(msg)
    except Exception as e:
        logger.error(f"LLM converse error: {e}")
        raise HTTPException(status_code=500, detail=f"AI error: {str(e)}")

    data = extract_json(raw or "") or {}
    raw_reply = (data.get("reply") or "").strip() or "..."
    # Separate the version with audio tags (for TTS) from the cleaned version (for chat display)
    voice_text_full = raw_reply
    reply_text = _strip_audio_tags(raw_reply)
    tone = (data.get("tone") or "neutral").lower()
    domain = data.get("domain")
    extracted_raw = data.get("extracted")
    memory_update = (data.get("memory_update") or "").strip()
    actions_raw = data.get("actions") or []

    extracted_obj = None
    if isinstance(extracted_raw, dict):
        try:
            extracted_obj = ExtractedFact(**{k: v for k, v in extracted_raw.items() if k in ExtractedFact.model_fields})
        except Exception:
            extracted_obj = None

    parsed_actions: List[Action] = []
    if isinstance(actions_raw, list):
        for a in actions_raw:
            if not isinstance(a, dict):
                continue
            try:
                parsed_actions.append(
                    Action(**{k: v for k, v in a.items() if k in Action.model_fields})
                )
            except Exception:
                continue

    ai_entry = TimelineEntry(
        role="ai",
        text=reply_text,
        voice_text=voice_text_full if voice_text_full != reply_text else None,
        tone=tone if tone in {"calm", "energetic", "concerned", "urgent", "warm", "neutral"} else "neutral",
        domain=domain if domain in {"soldi", "tempo", "spesa", "salute", "lavoro", "casa", "altro"} else None,
        extracted=extracted_obj,
        actions=parsed_actions,
    )
    await db.taccuino_timeline.insert_one(ai_entry.model_dump())

    # Update profile counters & memory
    profile.total_messages += 1
    profile.confidence_level = min(100, profile.confidence_level + 1)
    if memory_update and memory_update.lower() not in {"null", "none", ""}:
        sep = "\n- " if profile.memory_summary else "- "
        new_mem = (profile.memory_summary or "") + sep + memory_update
        # Truncate to keep it reasonable
        if len(new_mem) > 4000:
            new_mem = new_mem[-4000:]
        profile.memory_summary = new_mem
    profile = await save_profile(profile)

    return ConverseResponse(user_entry=user_entry, ai_entry=ai_entry, profile=profile)


@api_router.get("/recap")
async def api_recap(period: str = "today"):
    """Generate a quick summary of the user's day/week."""
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key not configured")

    profile = await get_or_create_profile()
    # Load today/week timeline
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    if period == "week":
        since = now - timedelta(days=7)
    else:
        since = now - timedelta(hours=24)
    docs = await db.taccuino_timeline.find(
        {"timestamp": {"$gte": since.isoformat()}},
        {"_id": 0},
    ).sort("timestamp", 1).to_list(500)
    if not docs:
        return {"recap": "Per ora non ho nulla da riassumere — racconta qualcosa!"}

    entries = [TimelineEntry(**d) for d in docs]
    history = "\n".join(
        f"{'Utente' if e.role == 'user' else 'AI'}: {e.text}" for e in entries
    )

    lang = profile.language or "it"
    lang_name = {"it": "italiano", "en": "english", "es": "español", "fr": "français", "de": "deutsch"}.get(lang, "italiano")
    sys = (
        f"Riassumi gli eventi rilevanti delle ultime {('168 ore' if period=='week' else '24 ore')} "
        f"in {lang_name}, in massimo 4-5 frasi naturali, come un amico che ti aggiorna. "
        "Concentra spese, impegni, anomalie e cose importanti. Niente liste numerate, parla normalmente. "
        "Rispondi SOLO con il testo del recap, niente JSON."
    )
    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=str(uuid.uuid4()),
            system_message=sys,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        out = await chat.send_message(UserMessage(text=history))
    except Exception as e:
        logger.error(f"recap error: {e}")
        raise HTTPException(status_code=500, detail="Recap generation failed")
    return {"recap": (out or "").strip(), "period": period}


# ---------- ElevenLabs TTS ----------
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")

_eleven_client = None


def _get_eleven_client():
    global _eleven_client
    if _eleven_client is not None:
        return _eleven_client
    if not _ELEVENLABS_AVAILABLE or not ELEVENLABS_API_KEY:
        return None
    try:
        _eleven_client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
        return _eleven_client
    except Exception as e:
        logger.error(f"ElevenLabs client init failed: {e}")
        return None


# Curated list of voices that work well for Italian.
# (voice_id, display name, short description, gender)
CURATED_VOICES = [
    {"voice_id": "XrExE9yKIg1WjnnlVkGX", "name": "Matilda", "description": "Femminile, calda e amichevole — perfetta per un assistente personale", "gender": "F", "accent": "multilingue"},
    {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah", "description": "Femminile, giovane e naturale", "gender": "F", "accent": "multilingue"},
    {"voice_id": "XB0fDUnXU5powFXDhCwa", "name": "Charlotte", "description": "Femminile, delicata e rilassante", "gender": "F", "accent": "multilingue"},
    {"voice_id": "cgSgspJ2msm6clMCkdW9", "name": "Jessica", "description": "Femminile, chiara ed espressiva", "gender": "F", "accent": "multilingue"},
    {"voice_id": "TX3LPaxmHKxFdv7VOQHJ", "name": "Liam", "description": "Maschile, giovane e sicuro", "gender": "M", "accent": "multilingue"},
    {"voice_id": "IKne3meq5aSn9XLyUdCD", "name": "Charlie", "description": "Maschile, rilassato e naturale", "gender": "M", "accent": "multilingue"},
    {"voice_id": "N2lVS1w4EtoT3dr4eOWO", "name": "Callum", "description": "Maschile, profondo e tranquillo", "gender": "M", "accent": "multilingue"},
    {"voice_id": "onwK4e9ZLuTAKqWW03F9", "name": "Daniel", "description": "Maschile, autorevole ma cordiale", "gender": "M", "accent": "multilingue"},
]


class TTSRequest(BaseModel):
    text: str
    voice_id: Optional[str] = None
    stability: Optional[float] = None
    similarity_boost: Optional[float] = None
    tone: Optional[str] = None  # "calm" | "warm" | "neutral" | "energetic" | "concerned" | "urgent"


def _voice_settings_for_tone(tone: Optional[str], stability: Optional[float], similarity: Optional[float]) -> dict:
    """Adapt ElevenLabs voice settings to the conversational tone.

    DRAMATIC EMPATHY MODE:
    - Stability VERY low (0.05-0.25) — voice is allowed to swing emotionally,
      whisper, sigh, laugh, get quiet or intense.
    - Style VERY high (0.65-0.95) — accentuates the voice's expressive personality.
    - Combined with eleven_v3 audio tags inline, this produces near-human emotion.

    Note: very low stability can occasionally produce minor artifacts (slight
    quiver). That's the trade-off for true emotional expressivity.
    """
    base_stability = 0.15 if stability is None else stability
    base_similarity = 0.78 if similarity is None else similarity
    style = 0.75
    speed = 1.0
    t = (tone or "neutral").lower()
    if t == "calm":
        base_stability = 0.25
        speed = 0.93
        style = 0.65
    elif t == "concerned":
        base_stability = 0.12
        speed = 0.92
        style = 0.85
    elif t == "warm":
        base_stability = 0.13
        speed = 0.96
        style = 0.85
    elif t == "energetic":
        base_stability = 0.08
        speed = 1.06
        style = 0.95
    elif t == "urgent":
        base_stability = 0.06
        speed = 1.10
        style = 0.95
    else:  # neutral
        base_stability = 0.18
        speed = 1.0
        style = 0.7
    return {
        "stability": base_stability,
        "similarity_boost": base_similarity,
        "style": style,
        "speed": speed,
        "use_speaker_boost": True,
    }


# Common ElevenLabs v3 audio tags (Italian + English) we ALLOW the LLM to use.
# Both languages work with v3; Italian feels more natural in our prompt.
_AUDIO_TAG_RE = re.compile(r"\[[a-zA-ZàèéìòùÀÈÉÌÒÙ /,'_-]{1,40}\]")


def _strip_audio_tags(text: str) -> str:
    """Remove [audio tags] from text — used for chat-bubble display."""
    if not text:
        return text
    cleaned = _AUDIO_TAG_RE.sub("", text)
    # Collapse double spaces created by removal
    cleaned = re.sub(r"  +", " ", cleaned).strip()
    # Also strip leading punctuation glue like " ,"
    cleaned = re.sub(r"\s+([,.;!?])", r"\1", cleaned)
    return cleaned


def _has_audio_tags(text: str) -> bool:
    return bool(_AUDIO_TAG_RE.search(text or ""))


@api_router.get("/voices")
async def api_list_voices():
    """Return the curated list of voices (plus user's custom voices if any)."""
    voices = list(CURATED_VOICES)
    client_el = _get_eleven_client()
    if client_el is not None:
        try:
            res = client_el.voices.get_all()
            all_voices = getattr(res, "voices", []) or []
            curated_ids = {v["voice_id"] for v in CURATED_VOICES}
            for v in all_voices:
                vid = getattr(v, "voice_id", None)
                name = getattr(v, "name", None)
                category = getattr(v, "category", "") or ""
                if vid and vid not in curated_ids and category in {"cloned", "generated", "professional"}:
                    voices.append({
                        "voice_id": vid,
                        "name": name or "Voce custom",
                        "description": f"Voce personale ({category})",
                        "gender": "?",
                        "accent": "custom",
                    })
        except Exception as e:
            logger.warning(f"Failed to fetch custom voices: {e}")
    return {"voices": voices, "enabled": bool(client_el)}


@api_router.post("/tts")
async def api_tts(req: TTSRequest):
    """Generate TTS audio using ElevenLabs and return MP3 bytes."""
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    # Cap text length to avoid runaway costs / long latency
    if len(text) > 1500:
        text = text[:1500]

    client_el = _get_eleven_client()
    if client_el is None:
        raise HTTPException(status_code=503, detail="ElevenLabs not configured")

    voice_id = req.voice_id or "XrExE9yKIg1WjnnlVkGX"
    voice_settings = _voice_settings_for_tone(req.tone, req.stability, req.similarity_boost)

    try:
        # Use eleven_v3 if the text contains audio tags ([sospira], [ride], etc.)
        # — only v3 honors them. Fallback to turbo_v2_5 for plain text (faster).
        use_v3 = _has_audio_tags(text)
        model = "eleven_v3" if use_v3 else "eleven_turbo_v2_5"
        try:
            convert_kwargs = dict(
                text=text,
                voice_id=voice_id,
                model_id=model,
                output_format="mp3_44100_128",
                voice_settings=voice_settings,
            )
            # CRITICAL: disable text normalization for v3 so ellipses, em-dashes,
            # trailing dots, and disfluencies ("ehm…", "boh…") are PRESERVED as
            # real audible pauses/hesitations instead of being "cleaned up".
            if use_v3:
                convert_kwargs["apply_text_normalization"] = "off"
            audio_gen = client_el.text_to_speech.convert(**convert_kwargs)
            audio_data = b""
            for chunk in audio_gen:
                if chunk:
                    audio_data += chunk
        except Exception as model_err:
            # If v3 fails (entitlement / outage) fall back: strip tags and retry with turbo
            if use_v3:
                logger.warning(f"eleven_v3 failed, falling back to turbo: {model_err}")
                clean = _strip_audio_tags(text)
                audio_gen = client_el.text_to_speech.convert(
                    text=clean or text,
                    voice_id=voice_id,
                    model_id="eleven_turbo_v2_5",
                    output_format="mp3_44100_128",
                    voice_settings=voice_settings,
                )
                audio_data = b""
                for chunk in audio_gen:
                    if chunk:
                        audio_data += chunk
            else:
                raise
        if not audio_data:
            raise HTTPException(status_code=500, detail="Empty TTS response")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"ElevenLabs TTS error: {e}")
        raise HTTPException(status_code=500, detail=f"TTS error: {str(e)}")

    return Response(
        content=audio_data,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store"},
    )


# In-memory cache for TTS audio served via GET URL.
# This avoids base64/data-URI playback issues on iOS Expo Go where
# Audio.Sound.createAsync({uri: "file://..."}) fails with -11800 errors.
# IMPORTANT: don't pop the audio on first GET — iOS AVPlayer often makes
# multiple HTTP requests (HEAD + Range) for the same URL. We keep it in
# memory until eviction (LRU max size, or natural restart).
_tts_audio_cache: dict[str, bytes] = {}
_tts_cache_order: list[str] = []
_TTS_CACHE_MAX = 50  # bound the cache size


def _store_tts_audio(audio: bytes) -> str:
    token = uuid.uuid4().hex
    _tts_audio_cache[token] = audio
    _tts_cache_order.append(token)
    while len(_tts_cache_order) > _TTS_CACHE_MAX:
        old = _tts_cache_order.pop(0)
        _tts_audio_cache.pop(old, None)
    return token


@api_router.post("/tts/prepare")
async def api_tts_prepare(req: TTSRequest):
    """Generate TTS and return a token that can be used with GET /tts/audio/{token}.mp3.

    This is the preferred path on mobile clients (Audio.Sound.createAsync on iOS
    can fail loading audio from local file URIs after base64 decoding).
    """
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    if len(text) > 1500:
        text = text[:1500]

    client_el = _get_eleven_client()
    if client_el is None:
        raise HTTPException(status_code=503, detail="ElevenLabs not configured")

    voice_id = req.voice_id or "XrExE9yKIg1WjnnlVkGX"
    voice_settings = _voice_settings_for_tone(req.tone, req.stability, req.similarity_boost)

    try:
        use_v3 = _has_audio_tags(text)
        model = "eleven_v3" if use_v3 else "eleven_turbo_v2_5"
        try:
            convert_kwargs = dict(
                text=text,
                voice_id=voice_id,
                model_id=model,
                output_format="mp3_44100_128",
                voice_settings=voice_settings,
            )
            if use_v3:
                # Preserve disfluencies, ellipses, em-dashes verbatim
                convert_kwargs["apply_text_normalization"] = "off"
            audio_gen = client_el.text_to_speech.convert(**convert_kwargs)
            audio_data = b""
            for chunk in audio_gen:
                if chunk:
                    audio_data += chunk
        except Exception as model_err:
            if use_v3:
                logger.warning(f"eleven_v3 failed, falling back to turbo: {model_err}")
                clean = _strip_audio_tags(text)
                audio_gen = client_el.text_to_speech.convert(
                    text=clean or text,
                    voice_id=voice_id,
                    model_id="eleven_turbo_v2_5",
                    output_format="mp3_44100_128",
                    voice_settings=voice_settings,
                )
                audio_data = b""
                for chunk in audio_gen:
                    if chunk:
                        audio_data += chunk
            else:
                raise
        if not audio_data:
            raise HTTPException(status_code=500, detail="Empty TTS response")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"ElevenLabs TTS error (prepare): {e}")
        raise HTTPException(status_code=500, detail=f"TTS error: {str(e)}")

    token = _store_tts_audio(audio_data)
    return {"token": token, "size": len(audio_data)}


@api_router.get("/tts/audio/{token}.mp3")
async def api_tts_audio(token: str, request: Request):
    """Serve previously prepared TTS audio.

    IMPORTANT: do NOT pop the token on first GET — iOS AVPlayer often makes
    multiple HTTP requests (HEAD + Range) and the audio must remain available
    for all of them. We rely on the LRU cache to evict eventually.

    Supports HTTP Range requests (required by iOS AVPlayer for proper
    streaming playback).
    """
    audio = _tts_audio_cache.get(token)
    if audio is None:
        raise HTTPException(status_code=404, detail="Not found")

    total = len(audio)
    range_header = request.headers.get("range") or request.headers.get("Range")
    if range_header and range_header.startswith("bytes="):
        try:
            r = range_header.replace("bytes=", "").strip()
            start_s, _, end_s = r.partition("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else total - 1
            if start < 0:
                start = 0
            if end >= total:
                end = total - 1
            if start > end:
                raise ValueError("invalid range")
            chunk = audio[start:end + 1]
            return Response(
                content=chunk,
                status_code=206,
                media_type="audio/mpeg",
                headers={
                    "Content-Range": f"bytes {start}-{end}/{total}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(len(chunk)),
                    "Cache-Control": "no-store",
                },
            )
        except Exception:
            # Fall through to full response on malformed range
            pass

    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-store",
            "Content-Length": str(total),
            "Accept-Ranges": "bytes",
        },
    )


# ---------- Demo media (promo video / screenshots) ----------
DEMO_FILES = {
    "mp4": ("compass_demo.mp4", "video/mp4"),
    "webm": ("compass_demo.webm", "video/webm"),
    "gif": ("compass_demo.gif", "image/gif"),
    "zip": ("store_assets.zip", "application/zip"),
    "ios-mp4": ("store_assets/video/appstore_preview_886x1920/appstore_preview_886x1920.mp4", "video/mp4"),
    "play-mp4": ("store_assets/video/playstore_preview_1080x1920/playstore_preview_1080x1920.mp4", "video/mp4"),
}


@api_router.get("/demo/{fmt}")
async def get_demo_media(fmt: str):
    if fmt not in DEMO_FILES:
        raise HTTPException(status_code=404, detail="format not found")
    filename, mime = DEMO_FILES[fmt]
    path = DEMO_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="demo file not generated")
    return FileResponse(
        str(path),
        media_type=mime,
        filename=Path(filename).name,
    )


@api_router.get("/demo-screen/{preset}/{name}")
async def get_demo_screenshot(preset: str, name: str):
    # allow only expected presets/filenames
    allowed_presets = {"ios_6_7", "play_store", "iphone_1284x2778_clean"}
    if preset not in allowed_presets:
        raise HTTPException(status_code=404, detail="unknown preset")
    if "/" in name or ".." in name or not name.endswith(".png"):
        raise HTTPException(status_code=400, detail="invalid filename")
    # Choose the right base dir for clean variants
    if preset.endswith("_clean"):
        path = DEMO_DIR / "store_assets_clean" / preset / name
    else:
        path = DEMO_DIR / "store_assets" / preset / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="screenshot not found")
    return FileResponse(str(path), media_type="image/png", filename=name)


# Include the router
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
