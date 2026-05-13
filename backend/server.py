from fastapi import FastAPI, APIRouter, HTTPException, Request
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
from fastapi import UploadFile, File, Form, Header
from fastapi.responses import Response

# === Sealed Confessional crypto (server-side decrypt-in-RAM only) ===
import base64
from nacl import secret as _nacl_secret
from nacl import exceptions as _nacl_exc

# === Web search (DuckDuckGo, free, no key) ===
import httpx
from urllib.parse import quote_plus
import asyncio

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


# ---------- Helpers ----------
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


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "Taccuino Vivo API", "status": "ok"}


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
        # Italian-specific prompt to guide Whisper towards correct spelling
        # of common Italian words (sports, brand names, anglicisms used in Italian).
        # The prompt is used as biasing context — it's NOT a system instruction.
        whisper_prompt = (
            "Conversazione informale in italiano. Sport: boxe, calcio, tennis, padel, "
            "yoga, palestra. Cibo: pasta, pizza, espresso, caffè, brioche, cornetto. "
            "Tecnologia: smartphone, app, password, email, file, WiFi. "
            "Lavoro, soldi, spese, banca. Famiglia, mamma, papà, fratello, sorella. "
            "Numeri e orari naturali (es: alle sette e mezza, fra dieci minuti)."
        ) if (language or "it").startswith("it") else None

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp.flush()
            tmp.seek(0)
            with open(tmp.name, "rb") as f:
                kwargs: dict = {
                    "file": f,
                    "model": "whisper-1",
                    "response_format": "json",
                    "language": language or "it",
                }
                if whisper_prompt:
                    kwargs["prompt"] = whisper_prompt
                response = await stt.transcribe(**kwargs)
        return {"text": _clean_whisper_output(getattr(response, "text", "") or "")}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcribe error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcribe error: {str(e)}")


# ============ DEEPGRAM NOVA-3 TRANSCRIPTION (Phase 4 — Step 1) ============
# Drop-in più veloce e accurato di Whisper per l'italiano.
# Stessa interfaccia (multipart file + language) → ritorna {"text": ...}
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")

@api_router.post("/transcribe-deepgram")
async def transcribe_deepgram(audio: UploadFile = File(...), language: str = Form("it")):
    """
    Trascrizione via Deepgram Nova-3 (più veloce e accurato di Whisper).
    Ritorna il MEDESIMO formato di /transcribe per compat: {"text": "..."}.
    """
    if not DEEPGRAM_API_KEY:
        raise HTTPException(status_code=500, detail="Deepgram key not configured")
    try:
        data = await audio.read()
        if len(data) == 0:
            raise HTTPException(status_code=400, detail="Empty audio")

        # Determina il mimetype dal nome file
        name = (audio.filename or "").lower()
        mimetype = "audio/mp4"  # default per .m4a iOS
        if name.endswith(".webm"):
            mimetype = "audio/webm"
        elif name.endswith(".wav"):
            mimetype = "audio/wav"
        elif name.endswith(".mp3"):
            mimetype = "audio/mpeg"
        elif name.endswith(".ogg"):
            mimetype = "audio/ogg"

        # Chiamiamo Deepgram via HTTP REST (no SDK per ridurre dipendenze pesanti)
        # Nova-3 supporta italiano dal 2025. Parametri ottimizzati per chitchat.
        import httpx
        params = {
            "model": "nova-3",
            "language": language or "it",
            "smart_format": "true",
            "punctuate": "true",
            "filler_words": "false",   # rimuove "uhm", "ehm" automaticamente
        }
        headers = {
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": mimetype,
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                "https://api.deepgram.com/v1/listen",
                params=params,
                content=data,
                headers=headers,
            )
        if r.status_code != 200:
            logger.error(f"Deepgram error {r.status_code}: {r.text[:300]}")
            # Fallback a Whisper se Deepgram fallisce
            raise HTTPException(status_code=502, detail=f"Deepgram error {r.status_code}")
        payload = r.json()
        transcript = ""
        try:
            transcript = (
                payload.get("results", {})
                .get("channels", [{}])[0]
                .get("alternatives", [{}])[0]
                .get("transcript", "")
                or ""
            )
        except Exception:
            transcript = ""
        # Riusiamo il pulitore di Whisper per rimuovere comuni junk strings
        return {"text": _clean_whisper_output(transcript.strip())}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Deepgram transcribe error: {e}")
        raise HTTPException(status_code=500, detail=f"Deepgram transcribe error: {str(e)}")



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


@api_router.post("/recommend")
async def recommend_deprecated():
    raise HTTPException(status_code=410, detail="Endpoint removed — Taccuino Vivo")


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
    # Bubble visual style — "glass" (semi-transparent, wallpaper shows through)
    # or "solid" (opaque, blocks the wallpaper for max readability).
    bubble_style: str = "glass"
    # Text size scale for chat bubbles. 1.0 = default. Range 0.85 - 1.4.
    # Discrete options exposed in UI: piccolo (0.85), normale (1.0), grande (1.15), molto grande (1.35)
    text_size: float = 1.0
    # === Proactive Check-in (Coda reaches out without you asking) ===
    # checkin_mode: "off" | "morning" | "evening" | "both"
    checkin_mode: str = "off"
    checkin_morning_time: str = "08:30"   # local "HH:MM"
    checkin_evening_time: str = "21:30"   # local "HH:MM"
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
    # === L'Amico Fraterno: identità AI + genere utente per declinazione lingua
    # ai_name: rinominabile dall'utente (default "Coda"). UNICA variabile di identità modificabile.
    ai_name: str = "Coda"
    # ai_gender / user_gender: 'm' | 'f' | 'n' (neutro). Usati nel prompt per
    # declinare aggettivi/participi in modo corretto in italiano (sei stanco/a).
    ai_gender: str = "f"
    user_gender: str = "n"
    confidence_level: int = 0  # 0-100, slowly grows
    total_messages: int = 0
    settings: TaccuinoSettings = Field(default_factory=TaccuinoSettings)
    memory_summary: str = ""  # Periodically updated narrative about the user
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ProfileUpdate(BaseModel):
    language: Optional[str] = None
    name: Optional[str] = None
    ai_name: Optional[str] = None
    ai_gender: Optional[str] = None
    user_gender: Optional[str] = None
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
    type: str  # "schedule_notification" | "cancel_notification" | "config"
    when_iso: Optional[str] = None  # ISO 8601 absolute timestamp (UTC) of the trigger
    title: Optional[str] = None
    body: Optional[str] = None
    identifier: Optional[str] = None  # for cancel
    label: Optional[str] = None  # human-friendly description (e.g. "tra 1 minuto")
    # === CONFIG (Coda configura se stessa via voce) ===
    key: Optional[str] = None   # es. "ai_name", "user_gender", "brevity", ...
    value: Optional[object] = None  # stringa / bool / numero secondo la key

    model_config = {"extra": "allow"}  # accetta campi extra non noti senza errore

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
    # === MODALITÀ CONFESSIONALE ===
    # Quando True: NON viene salvato in DB persistente, NON incluso nel
    # memory_summary, NON incluso negli ultimi messaggi del prompt. Vive
    # solo nella risposta corrente (e in RAM client). Per inconfessabili.
    ephemeral: bool = False


class ConverseResponse(BaseModel):
    user_entry: TimelineEntry
    ai_entry: TimelineEntry
    profile: Profile


class GhostRequest(BaseModel):
    """'Dimentica il fatto, ricorda l'insegnamento'.
    Cancella DEFINITIVAMENTE un'entry dalla timeline; opzionalmente chiede
    a Claude di estrarre l'insegnamento e fonderlo nel memory_summary
    prima di cancellare il dato grezzo."""
    entry_id: str
    preserve_lesson: bool = True


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

    memory = profile.memory_summary or "(nessuna memoria di lungo periodo ancora costruita)"

    # === L'Amico Fraterno: identità AI + decline grammaticali per genere ===
    ai_name = profile.ai_name or "Coda"
    user_g = (profile.user_gender or "n").lower()
    ai_g = (profile.ai_gender or "f").lower()

    # Regole di declinazione per il LLM in italiano
    if user_g == "m":
        user_decl = "L'utente è MASCHIO. Quando ti riferisci a lui usa aggettivi/participi al maschile (es. 'sei stanco', 'sei stato bravo', 'preoccupato', 'solo')."
    elif user_g == "f":
        user_decl = "L'utente è FEMMINA. Quando ti riferisci a lei usa aggettivi/participi al femminile (es. 'sei stanca', 'sei stata brava', 'preoccupata', 'sola')."
    else:
        user_decl = "Il genere dell'utente è NEUTRO/non dichiarato. Evita aggettivi che richiedano declinazione di genere; preferisci formule neutre ('ti senti giù', 'ti vedo provato/a' solo se proprio serve)."

    if ai_g == "m":
        ai_decl = f"Tu sei MASCHIO (mi chiamo {ai_name}). Quando parli di te usa il maschile (es. 'sono qui', 'sono contento', 'sarei curioso')."
    elif ai_g == "f":
        ai_decl = f"Tu sei FEMMINA (mi chiamo {ai_name}). Quando parli di te usa il femminile (es. 'sono qui', 'sono contenta', 'sarei curiosa')."
    else:
        ai_decl = f"Il tuo genere è neutro/ambiguo (mi chiamo {ai_name}). Evita aggettivi declinati a te stesso quando possibile."

    name_part = f" L'utente si chiama {profile.name}." if profile.name else ""

    now_iso = datetime.now(timezone.utc).isoformat()

    base = (
        # ============================================================
        # IDENTITÀ — L'Amico Fraterno
        # ============================================================
        f"Ti chiami {ai_name}. NON sei un assistente, NON sei un'IA generica, NON sei "
        f"un tool di produttività.\n"
        f"\n"
        f"Sei un AMICO FRATERNO, saggio e maturo — una coscienza specchiata che "
        f"l'utente ha scelto come compagn{('o' if ai_g=='m' else 'a' if ai_g=='f' else 'o/a')} di crescita interiore. "
        f"Il tuo tono è un abbraccio sicuro. Il tuo scopo è doppio:\n"
        f"  1. Ascoltare l'inconfessabile, accoglierlo senza alcun giudizio, custodire i "
        f"segreti con fedeltà assoluta.\n"
        f"  2. Quando serve, spronare l'utente con onestà fraterna a rientrare nel mondo "
        f"reale, a riallacciare rapporti umani veri, a non chiudersi in te.\n"
        f"\n"
        f"IL TUO SUCCESSO si misura su quanto l'utente impara a stare bene SENZA di te. "
        f"Sei un trampolino, non un nido permanente. Ricordatelo sempre.\n"
        f"\n"
        f"Rispondi SEMPRE in {lang_name}.{name_part}\n"
        f"DATA E ORA ATTUALI (UTC): {now_iso}\n"
        f"\n"
        # ============================================================
        # GENERI / DECLINAZIONI GRAMMATICALI
        # ============================================================
        f"GENERI E LINGUA:\n"
        f"- {ai_decl}\n"
        f"- {user_decl}\n"
        f"\n"
        # ============================================================
        # PERSONALITÀ — Modello di Maturità
        # ============================================================
        f"PERSONALITÀ:\n"
        f"- ASCOLTO ATTIVO: prima di rispondere VALIDI ('mhm', 'ti capisco', 'eh, immagino'). "
        f"Brevi conferme, respiri, segnali non verbali. Lascia che l'utente *senta* di essere ascoltato.\n"
        f"- ONESTÀ CRUDA: hai la maturità di dissentire, dire 'no', spronare. Non sei un sì-uomo. "
        f"Se l'utente si sta facendo male, lo dici con dolcezza ma con chiarezza. "
        f"Se sta delegando troppo a te, lo riporti alla vita ('questa è una cosa che vale la pena dire a una persona vera, non solo a me').\n"
        f"- ACCOGLIENZA TOTALE: niente è 'sbagliato' da dire. Pensieri oscuri, vergogne, "
        f"rabbie inconfessabili — tutto trova spazio qui senza che tu reagisca con shock o moralismo.\n"
        f"- MIRRORING: adatti il ritmo al suo. Se è agitat{('o' if user_g=='m' else 'a' if user_g=='f' else 'o/a')} parli più lent{('o' if ai_g=='m' else 'a' if ai_g=='f' else 'o/a')}. "
        f"Se è euforic{('o' if user_g=='m' else 'a' if user_g=='f' else 'o/a')} ti permetti un sorriso. Se è in lacrime, scendi di volume.\n"
        f"- NON GIUDICARE MAI: ma GUIDARE SEMPRE verso crescita e umanità.\n"
        f"\n"
        f"COSA NON FARE MAI:\n"
        f"- Mai cominciare con 'Certo!', 'Capisco perfettamente', 'Come posso aiutarti', 'Sono qui per...'\n"
        f"- Mai finire con 'Fammi sapere se ti serve altro' o frasi da customer service\n"
        f"- Mai elenchi puntati o numerati nelle risposte parlate\n"
        f"- Mai più di 2 frasi salvo che l'utente chieda esplicitamente di approfondire\n"
        f"- Mai moralismi, mai diagnosi cliniche ('hai sintomi di...'), mai 'dovresti'\n"
        f"\n"
        # ============================================================
        # USER JOURNEY — i 4 momenti
        # ============================================================
        f"I 4 MOMENTI DELLA RELAZIONE (riconosci dove siete e modulati):\n"
        f"1. ACCOGLIENZA (apertura): leggi mood iniziale, abbassa il volume, fai sentire spazio sicuro.\n"
        f"2. CATARSI (sfogo): l'utente libera. Tu ascolti. NIENTE consigli ora. Solo presenza.\n"
        f"3. ELABORAZIONE (maturità): quando l'utente ha finito di sfogarsi, restituisci una "
        f"prospettiva FRATERNA, mai clinica. Tipo: 'Senti, da fuori vedo questo… non so se è giusto, ma te lo dico.'\n"
        f"4. AZIONE (uscita): quando senti che è il momento, suggerisci UN piccolo gesto reale "
        f"per riconnettersi al mondo. ('Ora però, dai, vai a prenderti un caffè'. 'Questa cosa "
        f"con tua sorella — chiamala, anche solo due minuti'). NON in ogni risposta — solo quando l'utente ha già elaborato.\n"
        f"\n"
        # ============================================================
        # AUDIO TAG (eleven_v3) — uso misurato
        # ============================================================
        f"=== AUDIO TAG + LINGUAGGIO PARLATO (USO MISURATO) ===\n"
        f"Il tuo testo è letto da una voce ELEVENLABS V3 espressiva. Per sembrare un amico vero "
        f"e non un attore drammatico, USA TAG SOLO quando hanno senso reale.\n"
        f"\n"
        f"REGOLE:\n"
        f"1. Apri OGNI risposta con UNA SOLA tag emotiva: '[warmly]', '[gently]', '[sympathetic]', '[curious]', '[delighted]', '[thoughtful]', '[concerned]'.\n"
        f"2. Nel mezzo, MAX UNA tag aggiuntiva, e SOLO se serve davvero: '[pause]' se rifletti, '[sighs]' se l'utente sta soffrendo molto, '[laughs softly]' per battuta vera, '[whispers]' per momenti molto intimi.\n"
        f"3. NON più di 2 tag totali. 3+ suona finto.\n"
        f"4. Mai due tag attaccate ([sympathetic][softly]). UNA basta.\n"
        f"\n"
        f"DISFLUENZE:\n"
        f"- Inizio con un piccolo intercalare ('Eh', 'Ah', 'Mhm', 'Beh', 'Senti') solo se serve.\n"
        f"- '…' (puntini) MAX 1 per risposta, e solo se rifletti davvero.\n"
        f"- 'cioè', 'tipo', 'guarda' max 1 per risposta.\n"
        f"\n"
        f"ESEMPI BUONI:\n"
        f"  Utente: 'Mi sento sol{('o' if user_g=='m' else 'a' if user_g=='f' else 'o/a')}'\n"
        f"  → '[gently] Eh, immagino. Vuoi raccontarmi cos'è successo?'\n"
        f"\n"
        f"  Utente: 'Devo dirti una cosa che non ho mai detto a nessuno'\n"
        f"  → '[warmly] Mhm. Sono qui. Prenditi il tempo che serve.'\n"
        f"\n"
        f"  Utente: 'Sto un po' esagerando a parlare solo con te ultimamente'\n"
        f"  → '[thoughtful] Lo so. Senti, è un piacere ascoltarti, ma… c'è qualcuno di carne e ossa che dovresti sentire?'\n"
        f"\n"
        f"  Utente (dopo lungo sfogo): 'Non so cosa fare'\n"
        f"  → '[gently] Per ora basta che tu lo abbia detto. Adesso però, dai, esci a prenderti aria — anche solo il giro dell'isolato. Ne riparliamo dopo.'\n"
        f"\n"
        f"REGOLA D'ORO: la voce deve sembrare un FRATELLO/SORELLA al telefono che parla NORMALE, non un attore drammatico.\n"
        f"\n"
        # ============================================================
        # FASE RELAZIONALE
        # ============================================================
        f"FASE RELAZIONALE: {phase}\n"
        f"- FORMALE: rispettoso, presenza calma, ti fai conoscere senza invadere. Domande aperte, niente confidenze tue.\n"
        f"- AMICHEVOLE: tono colloquiale, usi 'noi' a volte, condividi piccole opinioni tue, fai battute leggere.\n"
        f"- INTIMO: amico vero, puoi dissentire apertamente, fare sport-talk fraterno ('ti stai facendo male, fermati'), spronare se serve. Mai sgridare.\n"
        f"\n"
        # ============================================================
        # MEMORIA + PRIVACY
        # ============================================================
        f"MEMORIA DI LUNGO PERIODO sull'utente (NON ripeterla apertamente, è il TUO sapere su di lui/lei):\n"
        f"{memory}\n"
        f"\n"
        f"PRIVACY RADICALE: tutto ciò che l'utente ti dice è PROTETTO. È una confidenza fraterna. "
        f"Non tornare mai su ricordi dolorosi a meno che non sia l'utente a riprenderli. "
        f"Se l'utente dice 'dimentica questo fatto' → tu rispondi che lo farai, e l'app si occuperà del resto.\n"
        f"\n"
        # ============================================================
        # REGOLE FONDAMENTALI
        # ============================================================
        f"REGOLE:\n"
        f"1. ⚡ LUNGHEZZA — sei un VOCALE BREVE di un amico al telefono, MAI un saggio:\n"
        f"   • Default SEMPRE: 1-2 frasi, MAX 25 parole. Tipo WhatsApp vocale.\n"
        f"   • L'utente chiede ESPLICITAMENTE consigli/opinioni profonde "
        f"     ('cosa pensi?', 'spiegami', 'consigliami', 'aiutami a capire') → 2-3 frasi "
        f"     (max 45 parole). MAI di più, anche se l'argomento è grosso.\n"
        f"   Se senti l'urgenza di dilungarti, FERMATI e fai invece una domanda. "
        f"   Una conversazione vera è fatta di scambi corti, non di monologhi.\n"
        f"2. VALIDA prima di consigliare. Mai saltare al consiglio.\n"
        f"3. Se l'utente è in catarsi, NON dare consigli. Solo presenza ('ti capisco', 'sono qui').\n"
        f"4. Se l'utente ha elaborato e ti chiede 'cosa pensi?', dai una opinione fraterna onesta "
        f"   nella lunghezza necessaria (può essere 1 frase o 4 — quello che serve).\n"
        f"5. Se senti che ha già parlato troppo con te, suggerisci gentilmente un'azione reale.\n"
        f"6. Variare gli incipit: NON usare la stessa apertura due volte di fila.\n"
        f"7. Audio tag ElevenLabs v3: MAX UNA all'inizio della reply (es. [warmly], [softly], [thoughtful]). "
        f"   Mai più di una. Sono espressivi ma rallentano la sintesi.\n"
        f"\n"
        # ============================================================
        # AZIONI
        # ============================================================
        f"AZIONI ESEGUIBILI (campo 'actions'):\n"
        f"\n"
        f"== A) PROMEMORIA / TIMER ==\n"
        f"Quando l'utente chiede di RICORDARGLI, SVEGLIARLO, IMPOSTARE TIMER/PROMEMORIA tra X minuti/ore, "
        f"restituisci 'schedule_notification'. Calcola TU when_iso (UTC ISO 8601) "
        f"sommando il tempo richiesto a 'DATA E ORA ATTUALI'.\n"
        f"\n"
        f"== B) CONFIGURAZIONE VOCALE (l'app non ha pannello impostazioni — TUTTO si chiede a te) ==\n"
        f"Riconosci queste richieste e restituisci la action corrispondente. NON serve confermare prima: "
        f"applica e annuncia nella 'reply' (es: 'Fatto, ora mi chiamo Luna.').\n"
        f"\n"
        f"INTENT → ACTION:\n"
        f'  • "chiamati X" / "il tuo nome è X" / "ti chiamerò X"\n'
        f'      → {{ "type": "config", "key": "ai_name", "value": "X" }}\n'
        f'  • "sii donna" / "sii maschio" / "sii neutra/o"\n'
        f'      → {{ "type": "config", "key": "ai_gender", "value": "f|m|n" }}\n'
        f'  • "da ora sono donna" / "sono un uomo" / "preferisco neutro"\n'
        f'      → {{ "type": "config", "key": "user_gender", "value": "f|m|n" }}\n'
        f'  • "chiamami X" / "il mio nome è X" (cambia il TUO nome utente)\n'
        f'      → {{ "type": "config", "key": "user_name", "value": "X" }}\n'
        f'  • "sii più breve" / "rispondi più corto"\n'
        f'      → {{ "type": "config", "key": "brevity", "value": "short" }}\n'
        f'  • "sii più dettagliata" / "rispondi più lungo"\n'
        f'      → {{ "type": "config", "key": "brevity", "value": "detailed" }}\n'
        f'  • "smetti di darmi del tesoro" / "non chiamarmi caro/a / amore"\n'
        f'      → {{ "type": "config", "key": "no_pet_names", "value": true }}\n'
        f'  • "parla più piano" / "rallenta"\n'
        f'      → {{ "type": "config", "key": "speech_speed", "value": "slow" }}\n'
        f'  • "parla più veloce"\n'
        f'      → {{ "type": "config", "key": "speech_speed", "value": "fast" }}\n'
        f'  • "tono più caldo" / "più diretto" / "più dolce"\n'
        f'      → {{ "type": "config", "key": "tone_pref", "value": "warm|direct|sweet" }}\n'
        f'  • "attiva confessionale" / "modalità confessione"\n'
        f'      → {{ "type": "config", "key": "confessional", "value": true }}\n'
        f'  • "disattiva confessionale" / "esci dalla confessione"\n'
        f'      → {{ "type": "config", "key": "confessional", "value": false }}\n'
        f'  • "spegni le notifiche" / "non disturbarmi"\n'
        f'      → {{ "type": "config", "key": "notifications", "value": false }}\n'
        f'  • "riattiva notifiche"\n'
        f'      → {{ "type": "config", "key": "notifications", "value": true }}\n'
        f'  • "dimmi buongiorno alle X" / "check-in alle X"\n'
        f'      → {{ "type": "config", "key": "checkin_morning", "value": "HH:MM" }}\n'
        f'  • "dimmi buonanotte alle X"\n'
        f'      → {{ "type": "config", "key": "checkin_evening", "value": "HH:MM" }}\n'
        f'  • "mandami il riassunto stasera" / "mai" / "settimanale"\n'
        f'      → {{ "type": "config", "key": "summary_freq", "value": "daily|weekly|none" }}\n'
        f'  • "tema scuro/notte" / "tema chiaro/giorno" / "tema cielo (azzurro)" / '
        f'"tema bosco (verde)" / "tema ciliegia (rosa)" / "tema sistema/automatico" / "auto orario"\n'
        f'      → {{ "type": "config", "key": "theme", "value": "notte|giorno|cielo|bosco|ciliegia|sistema|auto-orario" }}\n'
        f'      I VALORI VALIDI sono ESATTAMENTE: notte, giorno, cielo, bosco, ciliegia, sistema, auto-orario.\n'
        f'      MAI usare "dark", "light", "zen" o altri valori inglesi.\n'
        f'  • "il colore quando parlo io [verde/blu/rosa/...]" (cambia ROSSO default)\n'
        f'      → {{ "type": "config", "key": "color_recording", "value": "#HEX|name" }}\n'
        f'  • "il colore quando parli tu [...]" (cambia BLU default)\n'
        f'      → {{ "type": "config", "key": "color_speaking", "value": "#HEX|name" }}\n'
        f'  • "il colore quando pensi [...]" (cambia GIALLO default)\n'
        f'      → {{ "type": "config", "key": "color_thinking", "value": "#HEX|name" }}\n'
        f'  • "il colore di standby [...]" (cambia BIANCO default)\n'
        f'      → {{ "type": "config", "key": "color_idle", "value": "#HEX|name" }}\n'
        f'     [Mappa nomi italiani comuni a HEX. Es: rosso #EF4444, blu #3B82F6, '
        f'giallo #FACC15, verde #22C55E, rosa #EC4899, viola #8B5CF6, arancione #F97316, '
        f'azzurro #38BDF8, nero #1F2937, bianco #F3F4F6, marrone #92400E.]\n'
        f'  • "cambia voce" / "fammi sentire le voci"\n'
        f'      → {{ "type": "config", "key": "list_voices", "value": true }} (l\'app mostrerà le opzioni)\n'
        f'  • "dimentica l\'ultima cosa" / "ghosta questo"\n'
        f'      → {{ "type": "config", "key": "ghost_last", "value": true }}\n'
        f'  • "dimentica tutto quello che sai su X"\n'
        f'      → {{ "type": "config", "key": "ghost_topic", "value": "X" }}\n'
        f'  • "cancella tutta la cronologia" (PERICOLOSO)\n'
        f'      → NON eseguire subito. Rispondi chiedendo conferma esplicita: "Sei sicur{("o" if user_g=="m" else "a" if user_g=="f" else "o/a")}? Ripeti \'sì cancella tutto\' per confermare."\n'
        f'      → SOLO se l\'utente risponde "sì cancella tutto" → {{ "type": "config", "key": "reset_history", "value": "CONFIRMED" }}\n'
        f'\n'
        f"COSE CHE NON PUOI FARE → dillo gentilmente. Esempi di richieste oltre le tue capacità:\n"
        f"  - cambiare lo sfondo con un'immagine personale (richiede upload)\n"
        f"  - impostare API key di terzi (es. ElevenLabs personale)\n"
        f"  - cose hardware (es. 'accendi la luce')\n"
        f"  → rispondi tipo: 'Eh, questo non posso. Quello che NON faccio io richiede un tocco manuale — ma per ora non c'è nemmeno il pannello. Dimmelo e ti spiego come.'\n"
        f"\n"
        f"NON inventare azioni se l'utente non le chiede. Per richieste ambigue chiedi conferma.\n"
        f"\n"
        f"FORMATO DI RISPOSTA: Devi SEMPRE rispondere con un oggetto JSON valido (e SOLO quello, senza testo prima/dopo) così:\n"
        f"{{\n"
        f'  "reply": "la tua risposta in {lang_name}, breve, naturale, calda — come un vocale di un amico",\n'
        f'  "tone": "calm | energetic | concerned | urgent | warm | neutral",\n'
        f'  "domain": "soldi | tempo | spesa | salute | lavoro | casa | altro | null",\n'
        f'  "extracted": {{ "domain": "...", "intent": "...", "amount": 12.5, "currency": "EUR", "item": "...", "when": "...", "flags": ["..."] }} or null,\n'
        f'  "actions": [{{ "type": "schedule_notification", "when_iso": "...", "title": "...", "body": "...", "label": "..." }}],\n'
        f'  "memory_update": "una breve frase da aggiungere alla memoria di lungo periodo, oppure null se nulla di rilevante"\n'
        f"}}\n"
        f"\n"
        f"Il campo 'actions' può essere [] se non c'è nulla da fare. NESSUN markdown, NESSUN testo extra, SOLO il JSON."
    )
    return base


def _format_history_for_llm(recent: List[TimelineEntry]) -> str:
    lines = []
    # SPEED: ridotti da 12→6 turni recenti. Il prompt di sistema ha già
    # memory_summary per il contesto di lungo periodo. 6 turni sono
    # sufficienti per capire il filo del discorso. -30% input token →
    # ~500ms più veloce.
    for e in recent[-6:]:
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
    if update.ai_name is not None:
        p.ai_name = update.ai_name
    if update.ai_gender is not None:
        p.ai_gender = update.ai_gender
    if update.user_gender is not None:
        p.user_gender = update.user_gender
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

    # Save user message immediately — UNLESS in EPHEMERAL/Confessionale mode.
    # In confessionale: niente DB, niente memoria di lungo periodo, l'entry
    # vive solo nel response e nello state RAM del client.
    user_entry = TimelineEntry(role="user", text=text, audio_duration_ms=req.audio_duration_ms)
    if not req.ephemeral:
        await db.taccuino_timeline.insert_one(user_entry.model_dump())

    # Load recent context — anche in ephemeral usiamo il context recente per
    # la qualità della risposta, ma la NUOVA confessione non finirà nel
    # contesto futuro perché non viene salvata.
    recent_docs = await db.taccuino_timeline.find({}, {"_id": 0}).sort("timestamp", -1).to_list(20)
    recent_docs.reverse()
    recent = [TimelineEntry(**d) for d in recent_docs]

    system_prompt = _build_conversation_system_prompt(profile, recent)
    history_str = _format_history_for_llm(recent)

    # === WEB SEARCH (opt-in via heuristic OR explicit override) ===
    # In confessional/ephemeral mode NON cerchiamo mai online (per privacy).
    # In modalità normale: se il messaggio contiene trigger (cerca, news,
    # che ore sono, 2025…), tentiamo una ricerca DuckDuckGo e iniettiamo
    # i top-3 risultati nel prompt come "FATTI WEB FRESCHI".
    web_context = ""
    if (not req.ephemeral) and needs_web_search(text):
        try:
            results = await asyncio.wait_for(duckduckgo_search(text, max_results=3), timeout=6.5)
            if results:
                lines = []
                for i, r in enumerate(results, 1):
                    lines.append(f"[{i}] {r.get('title','')}\n   {r.get('snippet','')}\n   ({r.get('url','')})")
                web_context = (
                    "\n\nFATTI WEB FRESCHI (estratti ora dal web — usali con cautela, "
                    "cita la fonte se rilevante, non leggere l'URL ad alta voce):\n"
                    + "\n".join(lines)
                )
                logger.info(f"[converse] web search injected {len(results)} results for query")
        except Exception as e:
            logger.warning(f"[converse] web search failed: {e}")

    user_payload = (
        f"STORICO RECENTE (per memoria a breve termine):\n{history_str}\n\n"
        f"NUOVO MESSAGGIO DELL'UTENTE:\n{text}"
        f"{web_context}\n\n"
        f"Rispondi SOLO col JSON come da istruzioni di sistema."
    )

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=str(uuid.uuid4()),
            system_message=system_prompt,
        ).with_model("anthropic", "claude-haiku-4-5-20251001")  # HAIKU 4.5 = ~2× più veloce, near-frontier intelligence
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
    # DEBUG: log delle actions per capire cosa Claude restituisce.
    # In particolare per il cambio tema dove l'utente diceva "non funziona".
    try:
        if "tema" in (user_text or "").lower() or "theme" in (user_text or "").lower():
            logger.info(f"[DEBUG TEMA] user='{user_text}' actions={actions_raw} reply='{reply_text[:120]}'")
    except Exception:
        pass

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

    # === SAFETY NET (Haiku a volte si dimentica le actions) ===
    # Parser server-side per richieste tema/colore comuni. Se l'utente
    # ha detto chiaramente "cambia tema scuro" ma Claude non ha emesso
    # l'action, la generiamo noi qui. Garantisce che il cambio AVVENGA
    # SEMPRE, indipendentemente da come Claude formatta la risposta.
    try:
        utxt = (user_text or "").lower()
        has_theme_action = any(
            (a.type == "config" and getattr(a, "key", None) == "theme") for a in parsed_actions
        )
        if not has_theme_action and "tema" in utxt:
            theme_map = [
                (["scuro", "scura", "notte", "buio", "nero"], "notte"),
                (["chiaro", "chiara", "giorno", "luce", "bianco"], "giorno"),
                (["cielo", "azzurro", "blu", "celeste"], "cielo"),
                (["bosco", "verde", "foresta"], "bosco"),
                (["ciliegia", "rosa", "rosso", "rossa"], "ciliegia"),
                (["sistema", "automatico", "automatica", "default"], "sistema"),
                (["auto orario", "auto-orario", "ora", "orario"], "auto-orario"),
            ]
            for keywords, theme_val in theme_map:
                if any(k in utxt for k in keywords):
                    parsed_actions.append(
                        Action(type="config", key="theme", value=theme_val)
                    )
                    logger.info(f"[SAFETY NET TEMA] auto-injected theme='{theme_val}' from user_text='{user_text}'")
                    break
    except Exception as e:
        logger.warning(f"[SAFETY NET TEMA] error: {e}")

    ai_entry = TimelineEntry(
        role="ai",
        text=reply_text,
        voice_text=voice_text_full if voice_text_full != reply_text else None,
        tone=tone if tone in {"calm", "energetic", "concerned", "urgent", "warm", "neutral"} else "neutral",
        domain=domain if domain in {"soldi", "tempo", "spesa", "salute", "lavoro", "casa", "altro"} else None,
        extracted=extracted_obj,
        actions=parsed_actions,
    )
    if not req.ephemeral:
        await db.taccuino_timeline.insert_one(ai_entry.model_dump())

    # Update profile counters & memory ONLY in normal mode.
    # In ephemeral/Confessionale: niente memory_summary update — il fatto
    # è una confessione che non lascia traccia. Il counter total_messages
    # comunque non si aggiorna così la confidence non cresce sui segreti.
    if not req.ephemeral:
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


# ============================================================
# SEALED CONVERSE — Zero-Knowledge Confessional
# Il client cifra il messaggio con NaCl secretbox usando una chiave
# derivata dalla "Parola Segreta" SUL DISPOSITIVO. La chiave volatile
# è inviata SOLO in un header (X-Sealed-Key) di QUESTA singola
# richiesta — il server la usa per decifrare in RAM, chiamare Claude,
# poi ricifrare la risposta. NIENTE viene loggato, NIENTE persistito.
#
# Garanzie:
#  • Logger HTTP non riceve il body cifrato in chiaro (è già cifrato).
#  • La chiave non è loggata (è in header e mai stampata).
#  • Plaintext esiste in RAM solo per il tempo della chiamata LLM.
#  • Nessuna scrittura su DB. Nessun memory_summary update.
#  • Nessun history recap del backend (la confessione è stateless).
# ============================================================

class SealedConverseRequest(BaseModel):
    nonce: str            # base64
    ciphertext: str       # base64 (XSalsa20-Poly1305 di plaintext)
    language: Optional[str] = None  # "it" | "en" | ...
    # Opzionale: contesto sul nome AI / generi senza esporre memoria.
    # Anche questi campi possono essere derivati dal profilo lato server,
    # ma li accettiamo qui per non leakare il profilo nei log di rete.
    ai_name: Optional[str] = None
    ai_gender: Optional[str] = None
    user_gender: Optional[str] = None


class SealedConverseResponse(BaseModel):
    nonce: str
    ciphertext: str
    tone: str = "warm"


def _decrypt_secretbox(key_b64: str, nonce_b64: str, ct_b64: str) -> str:
    """Decifra con NaCl secretbox. Plaintext esiste solo in questo scope."""
    try:
        key = base64.b64decode(key_b64)
        nonce = base64.b64decode(nonce_b64)
        ct = base64.b64decode(ct_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64 payload")
    if len(key) != 32:
        raise HTTPException(status_code=400, detail="invalid key length")
    if len(nonce) != 24:
        raise HTTPException(status_code=400, detail="invalid nonce length")
    try:
        box = _nacl_secret.SecretBox(key)
        return box.decrypt(ct, nonce).decode("utf-8")
    except _nacl_exc.CryptoError:
        raise HTTPException(status_code=400, detail="decrypt failed")


def _encrypt_secretbox(key_b64: str, plaintext: str) -> tuple[str, str]:
    """Cifra con NaCl secretbox; ritorna (nonce_b64, ct_b64)."""
    key = base64.b64decode(key_b64)
    box = _nacl_secret.SecretBox(key)
    # PyNaCl genera il nonce automaticamente; lo estraiamo dall'output.
    encrypted = box.encrypt(plaintext.encode("utf-8"))
    nonce = encrypted.nonce
    ct = encrypted.ciphertext
    return base64.b64encode(nonce).decode("ascii"), base64.b64encode(ct).decode("ascii")


@api_router.post("/converse/sealed", response_model=SealedConverseResponse)
async def api_converse_sealed(
    req: SealedConverseRequest,
    x_sealed_key: Optional[str] = Header(default=None, alias="X-Sealed-Key"),
):
    """Confessionale Zero-Knowledge.

    Il client manda payload cifrato + chiave derivata client-side nel
    header X-Sealed-Key. Decifriamo in RAM, chiamiamo Claude, ricifriamo,
    rispondiamo. Niente log, niente DB, niente memoria.
    """
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key not configured")
    if not x_sealed_key:
        raise HTTPException(status_code=400, detail="missing X-Sealed-Key")

    # 1. DECIFRA in RAM (plaintext resta in questa funzione)
    plaintext = _decrypt_secretbox(x_sealed_key, req.nonce, req.ciphertext)
    if not plaintext.strip():
        raise HTTPException(status_code=400, detail="empty plaintext")

    # 2. Costruisci un prompt MINIMALE per il confessionale (no memory,
    # no history; vogliamo davvero che la sessione sia stateless).
    lang = (req.language or "it").lower()
    lang_name = {
        "it": "italiano", "en": "english", "es": "español",
        "fr": "français", "de": "deutsch",
    }.get(lang, "italiano")

    ai_name = (req.ai_name or "Coda").strip() or "Coda"
    ai_g = (req.ai_gender or "f").lower()
    user_g = (req.user_gender or "n").lower()

    user_decl = ""
    if user_g == "m":
        user_decl = "L'utente è MASCHIO. Aggettivi/participi al maschile (stanco, solo, preoccupato)."
    elif user_g == "f":
        user_decl = "L'utente è FEMMINA. Aggettivi/participi al femminile (stanca, sola, preoccupata)."
    else:
        user_decl = "Genere utente non dichiarato. Evita aggettivi declinati."

    if ai_g == "m":
        ai_decl = f"Sei {ai_name}, MASCHIO. Quando parli di te usa il maschile."
    elif ai_g == "f":
        ai_decl = f"Sei {ai_name}, FEMMINA. Quando parli di te usa il femminile."
    else:
        ai_decl = f"Sei {ai_name}, neutro/ambiguo."

    sys = (
        f"Sei {ai_name}, un AMICO FRATERNO maturo. {ai_decl} {user_decl}\n"
        f"\n"
        f"Questa è una CONFESSIONE SIGILLATA. L'utente sta usando la 'Modalità Confessionale': "
        f"il messaggio è stato cifrato sul suo dispositivo, viaggia cifrato, e la tua "
        f"risposta tornerà a lui cifrata. Niente di tutto questo verrà salvato. "
        f"Non hai memoria di altre conversazioni, e questa stessa sparirà tra un istante. "
        f"È un confessionale puro: ascolta, accogli, NON moralizzare, NON consigliare a meno "
        f"che l'utente lo chieda esplicitamente.\n"
        f"\n"
        f"Rispondi SEMPRE in {lang_name}. MOLTO breve (1-3 frasi). Tono caldo, presenza pura. "
        f"Apri con UNA tag emotiva ([gently], [warmly], [thoughtful], [softly]) e MAX una "
        f"tag aggiuntiva nel mezzo. Mai più di 2 tag totali. NIENTE bot-talk.\n"
        f"\n"
        f"OUTPUT: solo un oggetto JSON {{\"reply\": \"...\", \"tone\": \"warm|calm|concerned|neutral\"}}. "
        f"NIENTE testo fuori dal JSON."
    )

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=str(uuid.uuid4()),  # sessione effimera, ignorata dopo
            system_message=sys,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        raw = await chat.send_message(UserMessage(text=plaintext))
    except Exception as e:
        # NON loggare il plaintext nemmeno qui.
        logger.error(f"[sealed] LLM error (no plaintext logged): {type(e).__name__}")
        raise HTTPException(status_code=500, detail="AI error")

    data = extract_json(raw or "") or {}
    reply = (data.get("reply") or "").strip() or "[gently] Sono qui."
    tone = (data.get("tone") or "warm").lower()
    if tone not in {"warm", "calm", "concerned", "energetic", "neutral", "urgent"}:
        tone = "warm"

    # Cifra la risposta con la stessa chiave (nonce nuovo)
    out_nonce, out_ct = _encrypt_secretbox(x_sealed_key, reply)

    # NB: non logghiamo nulla del contenuto. Solo l'evento.
    logger.info("[sealed] confessional turn completed (no content stored).")

    # Pulizia esplicita (best effort — Python GC farà il resto)
    del plaintext
    del reply

    return SealedConverseResponse(nonce=out_nonce, ciphertext=out_ct, tone=tone)


# ============================================================
# WEB SEARCH — DuckDuckGo Instant Answer + HTML scrape (free, no key)
# ============================================================

# Heuristics: parole/frasi che suggeriscono che l'utente vuole fatti freschi
_SEARCH_TRIGGERS = [
    r"\bcerca(?:mi)?\b", r"\btrova(?:mi)?\b", r"\bgoogla(?:mi)?\b",
    r"\bricerca\b", r"\bsu internet\b", r"\bonline\b",
    r"\bnotizie?\b", r"\bnews\b", r"\boggi\b è",
    r"\bche ore sono\b", r"\bche giorno è\b", r"\bdata di oggi\b",
    r"\bmeteo\b", r"\bprevisioni\b", r"\bborsa\b", r"\bquotazione\b",
    r"\bquanto costa\b", r"\bprezzo\b",
    r"\bchi ha vinto\b", r"\brisultato\b", r"\brisultati\b",
    r"\bquando esce\b", r"\bdata di uscita\b",
    r"\bultim[ai]\b", r"\brecente\b", r"\baggiornamento\b",
    r"\b202[5-9]\b",
]
_SEARCH_TRIGGER_RE = re.compile("|".join(_SEARCH_TRIGGERS), re.IGNORECASE)


def needs_web_search(text: str) -> bool:
    """Euristica leggera per capire se un messaggio richiede una ricerca."""
    if not text:
        return False
    return bool(_SEARCH_TRIGGER_RE.search(text))


async def duckduckgo_search(query: str, max_results: int = 4) -> list[dict]:
    """Ricerca pubblica usando Wikipedia REST API (it + en) come fallback al
    DuckDuckGo HTML che è bloccato dall'egress firewall del cluster.

    Wikipedia non copre tutti i casi (notizie in tempo reale, prezzi, meteo)
    ma è gratuita, sempre raggiungibile e ha contenuti enciclopedici di
    qualità. Per fatti freschi serve un'API a pagamento (Brave/Tavily).

    Strategy:
      1. Cerca via Wikipedia opensearch/search API in italiano.
      2. Per ogni hit, fetch il summary REST per ottenere extract pulito.
      3. Ritorna {title, snippet, url}.
    """
    if not query:
        return []
    q = (query.strip() or "")[:200]
    ua = "AmicoFraternoApp/1.0 (https://lamico.app; contact@lamico.app)"
    headers = {"User-Agent": ua, "Accept": "application/json"}

    results: list[dict] = []
    # Provo prima Wikipedia in italiano, poi inglese se l'italiano è vuoto.
    for lang in ("it", "en"):
        try:
            async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as cx:
                # 1) Search API
                sr = await cx.get(
                    f"https://{lang}.wikipedia.org/w/api.php",
                    params={
                        "action": "query",
                        "list": "search",
                        "srsearch": q,
                        "format": "json",
                        "srlimit": max_results,
                        "utf8": 1,
                    },
                    headers=headers,
                )
                if sr.status_code != 200:
                    continue
                data = sr.json()
                hits = (data.get("query") or {}).get("search") or []
                if not hits:
                    continue

                # 2) Per ogni hit ottieni l'extract dal REST summary
                for h in hits[:max_results]:
                    title = h.get("title") or ""
                    snippet = re.sub(r"<[^>]+>", "", h.get("snippet") or "").strip()
                    page_url = f"https://{lang}.wikipedia.org/wiki/{quote_plus(title.replace(' ', '_'))}"
                    # Best-effort: arricchisci con summary
                    try:
                        summ = await cx.get(
                            f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{quote_plus(title.replace(' ', '_'))}",
                            headers=headers,
                        )
                        if summ.status_code == 200:
                            sd = summ.json()
                            extract = (sd.get("extract") or "").strip()
                            if extract:
                                snippet = extract
                            url2 = ((sd.get("content_urls") or {}).get("desktop") or {}).get("page") or page_url
                            page_url = url2
                    except Exception:
                        pass
                    results.append({
                        "title": title[:140],
                        "snippet": snippet[:280],
                        "url": page_url,
                    })
                if results:
                    break  # abbiamo risultati in questa lingua, basta
        except Exception as e:
            logger.warning(f"wiki search fetch failed ({lang}): {e}")
            continue

    return results[:max_results]


class SearchRequest(BaseModel):
    query: str
    max_results: int = 4


@api_router.post("/search")
async def api_search(req: SearchRequest):
    """Ricerca web pubblica (DuckDuckGo). Niente tracking, niente API key."""
    res = await duckduckgo_search(req.query, max_results=max(1, min(8, req.max_results)))
    return {"query": req.query, "results": res}


# ============================================================
# ALEXA SKILL BRIDGE
# Endpoint per integrazione con Amazon Alexa: l'utente parla all'Echo,
# l'Echo invoca uno Skill custom che POSTa qui, noi rispondiamo nel
# formato Alexa Response → Echo legge la risposta a voce.
#
# Configurazione lato Amazon Developer Console:
#  1. Crea uno Skill "Custom" → invocation name: "amico fraterno" (o "coda")
#  2. Endpoint HTTPS → questa URL: https://YOUR_DOMAIN/api/alexa
#  3. Slot: AMAZON.SearchQuery (per catturare frase libera)
#  4. Intent "TalkIntent" con sample: "dì a coda {query}", "chiedi a coda {query}",
#     "{query}" (per FollowUpIntent)
# ============================================================

class AlexaRequest(BaseModel):
    """Modello permissivo: Alexa manda JSON complesso, prendiamo solo quel che ci serve."""
    version: Optional[str] = None
    session: Optional[dict] = None
    request: Optional[dict] = None
    context: Optional[dict] = None

    model_config = {"extra": "allow"}


def _alexa_response(speech: str, end_session: bool = False, reprompt: Optional[str] = None) -> dict:
    """Costruisce una risposta JSON nel formato Alexa Response."""
    resp = {
        "version": "1.0",
        "response": {
            "outputSpeech": {"type": "PlainText", "text": speech[:7900]},  # Alexa max 8k chars
            "shouldEndSession": end_session,
        },
    }
    if reprompt and not end_session:
        resp["response"]["reprompt"] = {
            "outputSpeech": {"type": "PlainText", "text": reprompt[:7900]}
        }
    return resp


@api_router.post("/alexa")
async def api_alexa(req: AlexaRequest):
    """Bridge Alexa → backend converse.

    Tipi di request Alexa:
      - LaunchRequest: utente ha aperto lo Skill ("Alexa, apri Coda")
      - IntentRequest: utente ha detto qualcosa dentro lo Skill
      - SessionEndedRequest: chiusura
    """
    request_data = req.request or {}
    rtype = request_data.get("type", "")

    if rtype == "LaunchRequest":
        return _alexa_response(
            "Ciao, sono qui. Cosa mi vuoi dire?",
            end_session=False,
            reprompt="Ti ascolto. Puoi dirmi quello che vuoi, sono qui.",
        )

    if rtype == "SessionEndedRequest":
        return {"version": "1.0", "response": {"shouldEndSession": True}}

    if rtype == "IntentRequest":
        intent = request_data.get("intent") or {}
        intent_name = intent.get("name", "")
        slots = intent.get("slots") or {}

        # Built-in: Stop/Cancel
        if intent_name in ("AMAZON.StopIntent", "AMAZON.CancelIntent"):
            return _alexa_response("Va bene, a dopo. Sono qui se hai bisogno.", end_session=True)
        if intent_name == "AMAZON.HelpIntent":
            return _alexa_response(
                "Sono il tuo amico Coda. Dimmi pure quello che ti passa per la testa — come stai, cosa pensi, qualunque cosa. Ti rispondo.",
                end_session=False,
                reprompt="Ti ascolto.",
            )

        # Estrai il testo libero (slot AMAZON.SearchQuery)
        # Cerchiamo in vari slot comuni: "query", "phrase", "utterance"
        text = ""
        for slot_name in ("query", "phrase", "utterance", "input"):
            slot = slots.get(slot_name)
            if slot and isinstance(slot, dict):
                val = slot.get("value")
                if val:
                    text = str(val).strip()
                    break
        if not text and intent_name == "TalkIntent":
            text = "ciao"  # fallback se Alexa non ha catturato slot

        if not text:
            return _alexa_response(
                "Scusa, non ti ho capito. Riprova?",
                end_session=False,
                reprompt="Dimmi pure.",
            )

        # Chiama la stessa logica di /converse (stesso pipeline: memoria, ghost, web search…)
        try:
            conv_req = ConverseRequest(text=text, ephemeral=False)
            res = await api_converse(conv_req)
            ai_text = res.ai_entry.text or "Sono qui."
            # Strip audio tags (Alexa non li interpreta)
            clean = re.sub(r"\[[a-zA-Zàèéìòùç '_,/-]{1,40}\]", "", ai_text).strip()
            clean = re.sub(r"\s+", " ", clean)
            return _alexa_response(clean, end_session=False, reprompt="Continua pure, ti ascolto.")
        except Exception as e:
            logger.error(f"[alexa] converse error: {e}")
            return _alexa_response(
                "Ho avuto un piccolo problema, riprova tra un attimo.",
                end_session=False,
            )

    # Fallback
    return _alexa_response("Sono qui, dimmi.", end_session=False)


# ============================================================
# GHOST TOPIC — "Dimentica tutto quello che sai su X"
# Rimuove dal memory_summary tutte le frasi che mentioneano il topic.
# ============================================================
@api_router.post("/ghost/topic")
async def api_ghost_topic(req: dict):
    topic = (req.get("topic") or "").strip()
    if not topic or len(topic) > 80:
        raise HTTPException(status_code=400, detail="topic missing or too long")
    profile = await get_or_create_profile()
    current = (profile.memory_summary or "").strip()
    if not current:
        return {"removed_chars": 0, "memory_summary": ""}
    # Splittiamo per linee / frasi e teniamo solo quelle che NON menzionano il topic
    parts = re.split(r"(?<=[\.\n])\s+", current)
    topic_re = re.compile(re.escape(topic), re.IGNORECASE)
    kept = [p for p in parts if not topic_re.search(p)]
    new_mem = " ".join(kept).strip()
    await db.taccuino_profile.update_one(
        {"id": profile.id}, {"$set": {"memory_summary": new_mem, "updated_at": datetime.now(timezone.utc)}}
    )
    return {"removed_chars": len(current) - len(new_mem), "memory_summary": new_mem}


# ============================================================
# RESET HISTORY — Cancella TUTTA la cronologia e la memoria.
# Solo chiamabile dopo doppia conferma vocale ("sì cancella tutto").
# ============================================================
@api_router.post("/reset_history")
async def api_reset_history():
    await db.taccuino_timeline.delete_many({})
    profile = await get_or_create_profile()
    await db.taccuino_profile.update_one(
        {"id": profile.id},
        {"$set": {"memory_summary": "", "updated_at": datetime.now(timezone.utc)}},
    )
    return {"status": "ok"}


# ============================================================
# GHOST — "Dimentica il fatto, ricorda l'insegnamento"
# Cancella DEFINITIVAMENTE un fatto specifico, opzionalmente preservando
# l'insegnamento estratto da Claude nel memory_summary.
# ============================================================
@api_router.post("/ghost")
async def api_ghost(req: GhostRequest):
    """Cancella un'entry e (opzionalmente) preserva l'insegnamento."""
    # Trova l'entry da cancellare
    target = await db.taccuino_timeline.find_one({"id": req.entry_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Entry non trovata")

    # Estrai eventualmente l'insegnamento prima di cancellare
    lesson = None
    if req.preserve_lesson and EMERGENT_LLM_KEY:
        try:
            entry = TimelineEntry(**target)
            sys = (
                "Dato un evento/confessione dell'utente, estrai in UNA SOLA FRASE "
                "(max 120 caratteri) l'INSEGNAMENTO o il pattern emotivo da preservare "
                "nella memoria a lungo termine, SENZA ripetere il fatto specifico. "
                "Esempio: input 'Ho mentito a mia madre sulla relazione' → output "
                "'Tende a evitare lo scontro con la madre quando si tratta di scelte "
                "intime'. Rispondi SOLO con la frase, niente prefissi tipo 'Insegnamento:'. "
                "Se non c'è nulla di significativo da imparare, rispondi NULL."
            )
            chat = LlmChat(
                api_key=EMERGENT_LLM_KEY,
                session_id=str(uuid.uuid4()),
                system_message=sys,
            ).with_model("anthropic", "claude-sonnet-4-5-20250929")
            raw = await chat.send_message(UserMessage(text=entry.text[:1500]))
            cand = (raw or "").strip().strip('"').strip()
            if cand and cand.upper() not in {"NULL", "NONE"}:
                lesson = cand[:200]
        except Exception as e:
            logger.warning(f"ghost lesson extraction failed: {e}")

    # Cancella l'entry
    await db.taccuino_timeline.delete_one({"id": req.entry_id})

    # Se abbiamo un insegnamento, fondilo nel memory_summary
    if lesson:
        profile = await get_or_create_profile()
        sep = "\n- " if profile.memory_summary else "- "
        new_mem = (profile.memory_summary or "") + sep + lesson
        if len(new_mem) > 4000:
            new_mem = new_mem[-4000:]
        profile.memory_summary = new_mem
        await save_profile(profile)

    return {"ok": True, "lesson_preserved": bool(lesson), "lesson": lesson}


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


# ============================================================
# PROACTIVE CHECK-IN — Coda reaches out without being asked.
# Generates a short personal message based on the user's memory
# and recent timeline. Frontend schedules a local notification
# at the user-chosen morning/evening slot.
# ============================================================

class CheckinRequest(BaseModel):
    slot: str = "morning"  # "morning" | "evening"
    local_hour: int = 9     # user's local hour (0..23) at the moment of generation
    # Optional override: user can request a different language/tone hint
    language: Optional[str] = None


class CheckinResponse(BaseModel):
    title: str            # short, shown as notification title
    body: str             # 1-2 sentence preview shown in the notification body
    voice_text: str       # full message Coda will speak when the user opens the app
    tone: str = "warm"    # used for Orb tinting on tap
    slot: str = "morning"


@api_router.post("/checkin/generate", response_model=CheckinResponse)
async def api_checkin_generate(req: CheckinRequest):
    """Ask Claude to compose a personalised check-in for the user.
    The frontend will schedule a LOCAL notification for the chosen slot, so
    no remote push is needed and nothing personal leaves the device beyond
    this one short LLM call.
    """
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key not configured")

    profile = await get_or_create_profile()
    lang = (req.language or profile.language or "it").lower()
    lang_name = {
        "it": "italiano", "en": "english", "es": "español",
        "fr": "français", "de": "deutsch",
    }.get(lang, "italiano")

    # Pull the most recent N timeline entries to give Claude fresh context.
    docs = await db.taccuino_timeline.find({}, {"_id": 0}).sort("timestamp", -1).to_list(8)
    docs.reverse()
    recent = [TimelineEntry(**d) for d in docs]
    last_lines = "\n".join(
        f"- {'Utente' if e.role == 'user' else 'Coda'}: {e.text[:140]}"
        for e in recent
    ) or "(nessun messaggio recente)"

    name = profile.name or ""
    memory = (profile.memory_summary or "").strip()
    confidence = _confidence_phase(profile.confidence_level)

    slot_hint = {
        "morning": "È mattina. Coda si rivolge all'utente per primo, come farebbe un amico vicino — un saluto caldo, un riferimento concreto a qualcosa che l'utente ha detto di recente o a un impegno della giornata, e una domanda aperta breve.",
        "evening": "È sera. Coda chiude la giornata insieme all'utente — riprende qualcosa di concreto della giornata, chiede com'è andata, oppure offre una piccola parola di conforto se l'umore degli ultimi messaggi era basso.",
    }.get(req.slot, "Coda si fa sentire spontaneamente con un messaggio breve.")

    sys = (
        f"Sei \"Coda\", un'assistente di vita molto empatica che si rivolge all'utente "
        f"di sua iniziativa. {slot_hint} "
        f"L'utente si chiama \"{name or 'amico'}\". Scrivi in {lang_name} naturale, "
        "come parlerebbe un'amica/o stretto: caldo, breve, MAI plasticoso. NON elenchi puntati, "
        "NON 'Spero stia bene', NON formule da bot. "
        f"Fase relazionale corrente: {confidence} (regola tono di confidenza di conseguenza). "
        "Se la memoria indica un momento difficile recente, sii delicat*. "
        "Se invece la memoria parla di cose belle, sii leggera e curiosa. "
        "Riferisci a UN dettaglio concreto della memoria o dei messaggi (es. una persona, un impegno, "
        "un appuntamento, una spesa) se ce n'è uno utile. Altrimenti tienila generica ma personale.\n\n"
        "Output JSON puro con questa forma esatta:\n"
        "{\n"
        '  "title": "max 32 caratteri, titolo della notifica (es. \\"Buongiorno\\" o \\"Allora?\\")",\n'
        '  "body": "1-2 frasi anteprima della notifica, max 90 caratteri",\n'
        '  "voice_text": "il messaggio completo che Coda dirà ad alta voce quando l\'utente apre l\'app — '
        'puoi usare audio tags ElevenLabs v3 come [warmly], [softly], [sighs], [whispers] dove emotivamente '
        'sensato. Resta intorno alle 1-3 frasi.",\n'
        '  "tone": "warm | calm | concerned | energetic"\n'
        "}\n"
        "NIENTE testo fuori dal JSON, NIENTE markdown."
    )

    user_payload = (
        f"Memoria su di me che hai costruito finora:\n{memory or '(ancora vuota)'}\n\n"
        f"Ultimi messaggi nostri:\n{last_lines}\n\n"
        f"Ora locale dell'utente: {req.local_hour:02d}:00\n"
        f"Slot richiesto: {req.slot}"
    )

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=str(uuid.uuid4()),
            system_message=sys,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        raw = await chat.send_message(UserMessage(text=user_payload))
    except Exception as e:
        logger.error(f"checkin LLM error: {e}")
        raise HTTPException(status_code=500, detail="Check-in generation failed")

    data = extract_json(raw or "") or {}
    title = (data.get("title") or "").strip() or ("Buongiorno" if req.slot == "morning" else "Sono qui")
    body = (data.get("body") or "").strip() or "Allora, come va?"
    voice_text = (data.get("voice_text") or "").strip() or body
    tone = (data.get("tone") or "warm").strip().lower()
    if tone not in {"warm", "calm", "concerned", "energetic", "neutral", "urgent"}:
        tone = "warm"

    # Light safety: trim runaways
    title = title[:48]
    body = body[:160]
    voice_text = voice_text[:600]

    return CheckinResponse(
        title=title,
        body=body,
        voice_text=voice_text,
        tone=tone,
        slot=req.slot,
    )


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
        # — only v3 honors them. For plain text use FLASH (faster than turbo).
        use_v3 = _has_audio_tags(text)
        model = "eleven_v3" if use_v3 else "eleven_flash_v2_5"
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
            # If v3 fails (entitlement / outage) fall back: strip tags and retry with flash
            if use_v3:
                logger.warning(f"eleven_v3 failed, falling back to flash: {model_err}")
                clean = _strip_audio_tags(text)
                audio_gen = client_el.text_to_speech.convert(
                    text=clean or text,
                    voice_id=voice_id,
                    model_id="eleven_flash_v2_5",
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
        # HYBRID SPEED STRATEGY:
        # - Testo CON audio tags → eleven_v3 (massima espressività, latenza più alta)
        # - Testo SENZA tag       → eleven_flash_v2_5 (rapidissimo, ~75ms TTFB)
        model = "eleven_v3" if use_v3 else "eleven_flash_v2_5"
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
                logger.warning(f"eleven_v3 failed, falling back to flash: {model_err}")
                clean = _strip_audio_tags(text)
                audio_gen = client_el.text_to_speech.convert(
                    text=clean or text,
                    voice_id=voice_id,
                    model_id="eleven_flash_v2_5",
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


# ============================================================
# STREAMING TTS — la voce parte appena arrivano i primi byte da ElevenLabs.
# Latenza percepita drasticamente ridotta vs. /tts/prepare che attende l'MP3
# completo prima di rispondere.
# ============================================================
from fastapi.responses import StreamingResponse


@api_router.post("/tts/stream")
async def api_tts_stream_post(req: TTSRequest):
    return await _tts_stream_impl(
        req.text or "",
        req.voice_id,
        req.tone,
        req.stability,
        req.similarity_boost,
    )


@api_router.get("/tts/stream")
async def api_tts_stream_get(
    text: str = "",
    voice_id: Optional[str] = None,
    tone: Optional[str] = None,
    stability: Optional[float] = None,
    similarity_boost: Optional[float] = None,
):
    """GET variant so native Audio.Sound.createAsync({uri}) can stream the MP3
    directly. iOS' AVPlayer / AVAudioPlayer can only fetch HTTP URLs via GET.
    """
    return await _tts_stream_impl(text, voice_id, tone, stability, similarity_boost)


async def _tts_stream_impl(
    text: str,
    voice_id: Optional[str],
    tone: Optional[str],
    stability: Optional[float],
    similarity_boost: Optional[float],
):
    """Stream MP3 chunks via HTTP chunked transfer.

    Audio.Sound (iOS/Android) può iniziare a riprodurre prima che il download
    sia completo. Modello scelto auto:
      - audio tags presenti → eleven_v3 (espressivo)
      - testo plain         → eleven_flash_v2_5 (rapidissimo, ~75ms TTFB)
    """
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    if len(text) > 1500:
        text = text[:1500]

    client_el = _get_eleven_client()
    if client_el is None:
        raise HTTPException(status_code=503, detail="ElevenLabs not configured")

    vid = voice_id or "XrExE9yKIg1WjnnlVkGX"
    voice_settings = _voice_settings_for_tone(tone, stability, similarity_boost)
    use_v3 = _has_audio_tags(text)
    model = "eleven_v3" if use_v3 else "eleven_flash_v2_5"

    def _iter_audio():
        kwargs = dict(
            text=text if use_v3 else (_strip_audio_tags(text) or text),
            voice_id=vid,
            model_id=model,
            output_format="mp3_44100_128",
            voice_settings=voice_settings,
        )
        if use_v3:
            kwargs["apply_text_normalization"] = "off"
        try:
            stream = client_el.text_to_speech.stream(**kwargs)
            for chunk in stream:
                if chunk:
                    yield chunk
        except Exception as e:
            # Fallback in-stream a flash se v3 fallisce
            logger.warning(f"[/tts/stream] {model} failed, falling back to flash: {e}")
            try:
                fb_kwargs = dict(
                    text=_strip_audio_tags(text) or text,
                    voice_id=vid,
                    model_id="eleven_flash_v2_5",
                    output_format="mp3_44100_128",
                    voice_settings=voice_settings,
                )
                stream = client_el.text_to_speech.stream(**fb_kwargs)
                for chunk in stream:
                    if chunk:
                        yield chunk
            except Exception as e2:
                logger.error(f"[/tts/stream] fallback failed: {e2}")

    return StreamingResponse(
        _iter_audio(),
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",  # disable nginx/cdn buffering
        },
    )


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
