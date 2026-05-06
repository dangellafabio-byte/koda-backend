from fastapi import FastAPI, APIRouter, HTTPException
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
    input_mode: str = "voice"  # "voice" | "text"
    theme: str = "sistema"  # "sistema" | "auto-orario" | "notte" | "giorno" | "cielo" | "bosco" | "ciliegia"
    day_start_hour: int = 7   # used when theme = "auto-orario"
    night_start_hour: int = 20  # used when theme = "auto-orario"
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
    text: str
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
        f"2. Risposta MOLTO breve (1-3 frasi al massimo). Naturale come un vocale di un amico.\n"
        f"3. Se rileva un'anomalia (spesa stranamente alta, abbonamento sospetto), chiedi conferma con tono curioso, non accusatorio: 'Ehi... 80€... è normale o ti sembra strano?'.\n"
        f"4. Se l'utente chiede 'fammi il punto' o 'sunto' o 'recap', riassumi gli ultimi eventi importanti.\n"
        f"5. Se l'utente è stressato/sfogato, abbassa il tono, rassicura, non dare consigli a meno che non li chieda.\n"
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
        f"Nella 'reply' confermi all'utente in modo naturale (es: 'Ok, fra un minuto te lo ricordo.'). "
        f"NON inventare azioni se l'utente non le chiede.\n"
        f"\n"
        f"FORMATO DI RISPOSTA: Devi SEMPRE rispondere con un oggetto JSON valido (e SOLO quello, senza testo prima/dopo) così:\n"
        f"{{\n"
        f'  "reply": "la tua risposta in {lang_name}, breve, naturale, calda",\n'
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
    reply_text = (data.get("reply") or "").strip() or "..."
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
