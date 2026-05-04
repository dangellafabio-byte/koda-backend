from fastapi import FastAPI, APIRouter, HTTPException
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
        return {"text": getattr(response, "text", "") or ""}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcribe error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcribe error: {str(e)}")


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
