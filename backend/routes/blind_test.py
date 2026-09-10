"""
Blind Test API — TTS Cielo A/B (V3 vs Kyutai) — Piano B Fabio 2026-09-10
=========================================================================

Endpoint per il protocollo blind test:
  POST /api/blind-test/session          → crea/riprende sessione tester
  GET  /api/blind-test/next-pair        → prossima coppia (blind labels)
  POST /api/blind-test/vote             → salva voto rating + preferenza
  GET  /api/blind-test/audio/{clip_id}  → serve file audio (streaming)
  GET  /api/blind-test/results          → dashboard aggregata (admin only)

Modello DB (MongoDB, collezioni sotto `test_database`):
  blind_test_sessions  { session_id, tester_email, created_at, completed_at,
                         phrases_seen[], phrases_voted[], device_info }
  blind_test_clips     { clip_id, phrase_id, engine, filepath, duration_s,
                         created_at }
  blind_test_votes     { session_id, phrase_id, clip_a_id, clip_b_id,
                         rating_a (1-10), rating_b (1-10), preferred (A|B|TIE),
                         notes, voted_at }

Blind mapping: le label "A" e "B" mostrate al tester sono RANDOMIZZATE per
ogni coppia (50/50). Il mapping vero è salvato server-side in blind_test_clips
via `clip_id` (non deducibile dalla label).

NOTA: le clip audio vengono pre-generate offline via
`/app/backend/scripts/blind_test_generator.py` (da creare dopo che Fabio
conferma la fonte audio Cielo).
"""

import os
import uuid
import random
import logging
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends, Header, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from motor.motor_asyncio import AsyncIOMotorDatabase

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/blind-test", tags=["blind-test"])


# Storage clip audio: Emergent Object Storage o file locale in dev
BLIND_TEST_CLIP_DIR = os.getenv(
    "KODA_BLIND_TEST_CLIP_DIR",
    "/app/backend/_blind_test_clips",
)

# Engine A = reference V3 fisso. Engine B = candidato in test (rollout
# progressivo Kyutai → MegaTTS3 → XTTS-v2). Cambio via env var.
ENGINE_A_ID = "elevenlabs_v3_reference_A"
ENGINE_B_ID = os.getenv("KODA_BLIND_TEST_ENGINE_B", "kyutai_tts_local_B")

# Admin email autorizzato a vedere risultati aggregati
ADMIN_EMAILS = {
    "dangella.fabio@gmail.com",
    "wqm4r4jn7f@privaterelay.appleid.com",
}


# ============================================================================
# SCHEMA REQUEST / RESPONSE
# ============================================================================


class SessionStartRequest(BaseModel):
    tester_email: str = Field(..., min_length=3, max_length=200)
    tester_name: Optional[str] = None
    device_info: Optional[str] = None  # e.g. "iPhone 15 Pro / iOS 18.2"
    # === Fabio 2026-09-10 v2 — Gate 1 pre-test flag ==========================
    # Se True, la sessione usa solo le 5 frasi Gate 1 (go/no-go tecnico
    # Neo+Fabio, prima di committare 68 clip). Se False, blind test integrale.
    pretest_only: bool = False


class SessionStartResponse(BaseModel):
    session_id: str
    phrases_remaining: int
    resumed: bool  # True se ripresa da sessione precedente


class NextPairResponse(BaseModel):
    phrase_id: str
    phrase_text: str
    category: str
    clip_a_url: str  # URL blind, non rivela quale engine
    clip_b_url: str  # URL blind, non rivela quale engine
    remaining: int
    total: int


class VoteRequest(BaseModel):
    session_id: str
    phrase_id: str
    # === Fabio 2026-09-10 v2 — 3 rating separati (Gate 1 pre-test) ==========
    # Un TTS può essere bello in demo ma insopportabile dopo 20 min di
    # conversazione. Tre dimensioni indipendenti:
    #   - naturalness  = suona come una persona vera?
    #   - similarity   = suona come Cielo? (il timbro/personalità)
    #   - desirability = ci vorresti parlare a lungo? (la METRICA CRITICA)
    naturalness_a: int = Field(..., ge=1, le=10)
    naturalness_b: int = Field(..., ge=1, le=10)
    similarity_a: int = Field(..., ge=1, le=10)
    similarity_b: int = Field(..., ge=1, le=10)
    desirability_a: int = Field(..., ge=1, le=10)
    desirability_b: int = Field(..., ge=1, le=10)
    preferred: str = Field(..., pattern="^(A|B|TIE)$")
    notes: Optional[str] = Field(default=None, max_length=500)


class VoteResponse(BaseModel):
    ok: bool
    voted_count: int
    remaining: int


class AggregateResults(BaseModel):
    total_votes: int
    total_sessions: int
    completed_sessions: int
    # Per engine: media rating, count wins, count losses, count ties
    engine_stats: dict
    # Per categoria: preferenza aggregata
    category_stats: dict


# ============================================================================
# DEPENDENCY: MongoDB handle (viene iniettato da server.py al momento
# della registrazione del router)
# ============================================================================


_db_ref: Optional[AsyncIOMotorDatabase] = None


def register_db(db: AsyncIOMotorDatabase) -> None:
    """Chiamato da server.py all'avvio per iniettare il DB handle."""
    global _db_ref
    _db_ref = db


def db() -> AsyncIOMotorDatabase:
    if _db_ref is None:
        raise HTTPException(500, "Blind test DB not initialized")
    return _db_ref


# ============================================================================
# HELPER: caricamento phrase set + selezione coppia blind
# ============================================================================


def _phrases_source_path() -> str:
    # File in /app/backend/scripts/, questo modulo in /app/backend/routes/
    return os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "scripts",
        "blind_test_phrases.jsonc",
    )


_phrases_cache: Optional[List[dict]] = None
_phrases_meta_cache: Optional[dict] = None


def _load_phrases(pretest_only: bool = False) -> List[dict]:
    """Carica set frasi dal file JSONC, cachato.
    Se `pretest_only=True`, ritorna SOLO le 5 frasi selezionate per Gate 1
    (elencate in meta.gate_1_pretest_phrase_ids).
    """
    global _phrases_cache, _phrases_meta_cache
    if _phrases_cache is None:
        import json
        path = _phrases_source_path()
        if not os.path.exists(path):
            raise HTTPException(500, f"Phrase set not found: {path}")
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
        # Strip JSONC/hash comments: // ... , /* ... */, # ...
        import re
        stripped = re.sub(r"//.*?$", "", raw, flags=re.MULTILINE)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
        stripped = re.sub(r"^\s*#.*?$", "", stripped, flags=re.MULTILINE)
        data = json.loads(stripped)
        _phrases_cache = data.get("phrases", [])
        _phrases_meta_cache = data.get("meta", {})

    if pretest_only:
        pretest_ids = set(
            (_phrases_meta_cache or {}).get("gate_1_pretest_phrase_ids", [])
        )
        return [p for p in _phrases_cache if p["id"] in pretest_ids]
    return _phrases_cache


# ============================================================================
# ENDPOINT — SESSION START
# ============================================================================


@router.post("/session", response_model=SessionStartResponse)
async def start_session(req: SessionStartRequest):
    """
    Crea nuova sessione tester o riprende una esistente per la stessa email.
    Ogni tester vota TUTTE le frasi del set. Se torna sull'app dopo
    aver votato metà, riprende da dove aveva lasciato.

    `pretest_only=True` limita la sessione alle 5 frasi Gate 1 (Fabio+Neo).
    """
    coll = db().blind_test_sessions
    existing = await coll.find_one(
        {"tester_email": req.tester_email.lower().strip(), "completed_at": None}
    )
    if existing:
        phrases = _load_phrases(pretest_only=existing.get("pretest_only", False))
        voted = existing.get("phrases_voted", [])
        return SessionStartResponse(
            session_id=existing["session_id"],
            phrases_remaining=len(phrases) - len(voted),
            resumed=True,
        )

    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    await coll.insert_one({
        "session_id": session_id,
        "tester_email": req.tester_email.lower().strip(),
        "tester_name": (req.tester_name or "").strip() or None,
        "device_info": (req.device_info or "").strip() or None,
        "created_at": now,
        "completed_at": None,
        "phrases_voted": [],
        "pretest_only": bool(req.pretest_only),
        "engine_b_used": ENGINE_B_ID,
    })
    phrases = _load_phrases(pretest_only=req.pretest_only)
    return SessionStartResponse(
        session_id=session_id,
        phrases_remaining=len(phrases),
        resumed=False,
    )


# ============================================================================
# ENDPOINT — NEXT PAIR (blind)
# ============================================================================


@router.get("/next-pair", response_model=NextPairResponse)
async def next_pair(session_id: str):
    """
    Ritorna la prossima coppia A/B da valutare. Ordine deterministico dalla
    lista phrases[], ma la label A/B è RANDOMIZZATA per ogni coppia.
    """
    session = await db().blind_test_sessions.find_one({"session_id": session_id})
    if not session:
        raise HTTPException(404, "Session not found")
    if session.get("completed_at"):
        raise HTTPException(400, "Session already completed")

    phrases = _load_phrases(pretest_only=session.get("pretest_only", False))
    voted = set(session.get("phrases_voted", []))
    next_phrase = next((p for p in phrases if p["id"] not in voted), None)
    if not next_phrase:
        # Tutte votate → completa sessione
        await db().blind_test_sessions.update_one(
            {"session_id": session_id},
            {"$set": {"completed_at": datetime.now(timezone.utc)}},
        )
        raise HTTPException(404, "All phrases voted (session completed)")

    # Trova clip per questa frase su entrambi i motori (engine A e B)
    clips = await db().blind_test_clips.find(
        {"phrase_id": next_phrase["id"]}
    ).to_list(10)
    engines_available = {c["engine"]: c for c in clips}
    if ENGINE_A_ID not in engines_available or ENGINE_B_ID not in engines_available:
        raise HTTPException(
            500,
            f"Clip mancanti per frase {next_phrase['id']}: "
            f"servono {ENGINE_A_ID} + {ENGINE_B_ID}, "
            f"disponibili {list(engines_available.keys())}",
        )

    # Blind randomization: 50/50 quale ordine viene mostrato al tester
    if random.random() < 0.5:
        label_a_clip = engines_available[ENGINE_A_ID]
        label_b_clip = engines_available[ENGINE_B_ID]
    else:
        label_a_clip = engines_available[ENGINE_B_ID]
        label_b_clip = engines_available[ENGINE_A_ID]

    # Persiste il mapping blind per questa specifica visualizzazione, così
    # al momento del voto sappiamo "A" e "B" nel contesto del tester = quale engine.
    # Chiave: session_id + phrase_id. Chi vota deve fare submit prima che
    # arrivi un'altra next-pair sulla stessa frase.
    await db().blind_test_pair_serves.replace_one(
        {"session_id": session_id, "phrase_id": next_phrase["id"]},
        {
            "session_id": session_id,
            "phrase_id": next_phrase["id"],
            "label_a_clip_id": label_a_clip["clip_id"],
            "label_a_engine": label_a_clip["engine"],
            "label_b_clip_id": label_b_clip["clip_id"],
            "label_b_engine": label_b_clip["engine"],
            "served_at": datetime.now(timezone.utc),
        },
        upsert=True,
    )

    return NextPairResponse(
        phrase_id=next_phrase["id"],
        phrase_text=next_phrase["text"],
        category=next_phrase["category"],
        clip_a_url=f"/api/blind-test/audio/{label_a_clip['clip_id']}",
        clip_b_url=f"/api/blind-test/audio/{label_b_clip['clip_id']}",
        remaining=len(phrases) - len(voted),
        total=len(phrases),
    )


# ============================================================================
# ENDPOINT — VOTE
# ============================================================================


@router.post("/vote", response_model=VoteResponse)
async def vote(req: VoteRequest):
    """
    Registra voto per una coppia. Recupera il mapping blind salvato in
    next-pair per attribuire i rating al motore corretto.
    """
    served = await db().blind_test_pair_serves.find_one({
        "session_id": req.session_id,
        "phrase_id": req.phrase_id,
    })
    if not served:
        raise HTTPException(400, "No pair served for this session/phrase")

    # Costruisci il record di voto con mapping blind risolto
    engine_a = served["label_a_engine"]
    engine_b = served["label_b_engine"]
    if req.preferred == "A":
        preferred_engine = engine_a
    elif req.preferred == "B":
        preferred_engine = engine_b
    else:
        preferred_engine = None  # TIE

    await db().blind_test_votes.insert_one({
        "session_id": req.session_id,
        "phrase_id": req.phrase_id,
        "engine_a_shown_as_A": engine_a,
        "engine_b_shown_as_B": engine_b,
        # 3 rating separati per lato (Fabio 2026-09-10 v2)
        "naturalness_for_engine_a": req.naturalness_a,
        "naturalness_for_engine_b": req.naturalness_b,
        "similarity_for_engine_a": req.similarity_a,
        "similarity_for_engine_b": req.similarity_b,
        "desirability_for_engine_a": req.desirability_a,
        "desirability_for_engine_b": req.desirability_b,
        "preferred_label": req.preferred,
        "preferred_engine": preferred_engine,
        "notes": (req.notes or "").strip() or None,
        "voted_at": datetime.now(timezone.utc),
    })

    # Update session
    await db().blind_test_sessions.update_one(
        {"session_id": req.session_id},
        {"$addToSet": {"phrases_voted": req.phrase_id}},
    )
    session = await db().blind_test_sessions.find_one(
        {"session_id": req.session_id}
    )
    voted_count = len(session.get("phrases_voted", []))
    total = len(_load_phrases(pretest_only=session.get("pretest_only", False)))

    if voted_count >= total:
        await db().blind_test_sessions.update_one(
            {"session_id": req.session_id},
            {"$set": {"completed_at": datetime.now(timezone.utc)}},
        )

    return VoteResponse(
        ok=True,
        voted_count=voted_count,
        remaining=total - voted_count,
    )


# ============================================================================
# ENDPOINT — AUDIO SERVING (blind, mai rivela l'engine)
# ============================================================================


@router.get("/audio/{clip_id}")
async def serve_audio(clip_id: str):
    clip = await db().blind_test_clips.find_one({"clip_id": clip_id})
    if not clip:
        raise HTTPException(404, "Clip not found")
    filepath = clip.get("filepath")
    if not filepath or not os.path.exists(filepath):
        raise HTTPException(404, f"Audio file missing: {filepath}")
    # Content-type dinamico dall'estensione — Safari/iOS è più stretto di Chrome
    # e rifiuta WAV serviti come audio/mpeg. Preserviamo blind (nessun hint engine).
    ext = os.path.splitext(filepath)[1].lower()
    mt = "audio/wav" if ext == ".wav" else "audio/mpeg"
    # NO metadata engine nell'HTTP response → blind test integrità garantita
    return FileResponse(
        filepath,
        media_type=mt,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


# ============================================================================
# ENDPOINT — AGGREGATE RESULTS (admin only)
# ============================================================================


@router.get("/results", response_model=AggregateResults)
async def aggregate_results(x_admin_email: Optional[str] = Header(None)):
    if not x_admin_email or x_admin_email.lower().strip() not in ADMIN_EMAILS:
        raise HTTPException(403, "Admin only")

    votes = await db().blind_test_votes.find({}).to_list(10_000)
    sessions = await db().blind_test_sessions.find({}).to_list(1_000)

    engine_stats: dict = {}
    category_stats: dict = {}
    phrases = _load_phrases()
    phrase_to_cat = {p["id"]: p["category"] for p in phrases}

    for v in votes:
        e_a = v["engine_a_shown_as_A"]
        e_b = v["engine_b_shown_as_B"]
        # Fabio 2026-09-10 v2 — 3 dimensioni separate
        nat_a = v.get("naturalness_for_engine_a") or v.get("rating_for_engine_a", 0)
        nat_b = v.get("naturalness_for_engine_b") or v.get("rating_for_engine_b", 0)
        sim_a = v.get("similarity_for_engine_a", 0)
        sim_b = v.get("similarity_for_engine_b", 0)
        des_a = v.get("desirability_for_engine_a", 0)
        des_b = v.get("desirability_for_engine_b", 0)
        pref = v["preferred_engine"]  # None = TIE
        cat = phrase_to_cat.get(v["phrase_id"], "UNKNOWN")

        for engine, nat, sim, des in [
            (e_a, nat_a, sim_a, des_a),
            (e_b, nat_b, sim_b, des_b),
        ]:
            s = engine_stats.setdefault(engine, {
                "naturalness_sum": 0, "naturalness_count": 0,
                "similarity_sum": 0, "similarity_count": 0,
                "desirability_sum": 0, "desirability_count": 0,
                "wins": 0, "losses": 0, "ties": 0,
            })
            s["naturalness_sum"] += nat
            s["naturalness_count"] += 1
            if sim:
                s["similarity_sum"] += sim
                s["similarity_count"] += 1
            if des:
                s["desirability_sum"] += des
                s["desirability_count"] += 1

        if pref is None:
            engine_stats[e_a]["ties"] += 1
            engine_stats[e_b]["ties"] += 1
        else:
            loser = e_b if pref == e_a else e_a
            engine_stats[pref]["wins"] += 1
            engine_stats[loser]["losses"] += 1

        cs = category_stats.setdefault(cat, {
            "total_votes": 0,
            "preference": {},  # engine → count preferito
        })
        cs["total_votes"] += 1
        pref_key = pref or "TIE"
        cs["preference"][pref_key] = cs["preference"].get(pref_key, 0) + 1

    # Calcola medie per engine — 3 dimensioni + preferenza globale
    for engine, s in engine_stats.items():
        s["naturalness_mean"] = (
            round(s["naturalness_sum"] / s["naturalness_count"], 2)
            if s["naturalness_count"] > 0 else 0.0
        )
        s["similarity_mean"] = (
            round(s["similarity_sum"] / s["similarity_count"], 2)
            if s["similarity_count"] > 0 else 0.0
        )
        s["desirability_mean"] = (
            round(s["desirability_sum"] / s["desirability_count"], 2)
            if s["desirability_count"] > 0 else 0.0
        )

    return AggregateResults(
        total_votes=len(votes),
        total_sessions=len(sessions),
        completed_sessions=sum(1 for s in sessions if s.get("completed_at")),
        engine_stats=engine_stats,
        category_stats=category_stats,
    )


# ============================================================================
# ENDPOINT — GATE 1 SUMMARY (admin only) — go/no-go tecnico
# ============================================================================


@router.get("/gate-1-summary")
async def gate_1_summary(x_admin_email: Optional[str] = Header(None)):
    """
    Summary specifica per Gate 1 pre-test (5 frasi Neo+Fabio).
    Criteri PASS: MEDIA(desirability_B) >= 7.0 AND naturalness_B >= 6.5 AND
    similarity_B >= 6.0.
    Se motore B fallisce → si passa al motore successivo (env
    KODA_BLIND_TEST_ENGINE_B).
    """
    if not x_admin_email or x_admin_email.lower().strip() not in ADMIN_EMAILS:
        raise HTTPException(403, "Admin only")

    # Solo voti su sessioni pretest_only=True
    pretest_sessions = await db().blind_test_sessions.find(
        {"pretest_only": True}
    ).to_list(100)
    pretest_sid_set = {s["session_id"] for s in pretest_sessions}
    if not pretest_sid_set:
        return {
            "engine_b_in_test": ENGINE_B_ID,
            "sessions": 0,
            "verdict": "NO_DATA",
            "note": "Nessuna sessione pretest_only=True completata",
        }

    votes = await db().blind_test_votes.find(
        {"session_id": {"$in": list(pretest_sid_set)}}
    ).to_list(1000)

    # Aggrega per engine
    stats = {}
    for v in votes:
        for engine_key, nat_k, sim_k, des_k in [
            (v["engine_a_shown_as_A"],
             "naturalness_for_engine_a",
             "similarity_for_engine_a",
             "desirability_for_engine_a"),
            (v["engine_b_shown_as_B"],
             "naturalness_for_engine_b",
             "similarity_for_engine_b",
             "desirability_for_engine_b"),
        ]:
            s = stats.setdefault(engine_key, {
                "naturalness": [], "similarity": [], "desirability": [],
            })
            if v.get(nat_k) is not None:
                s["naturalness"].append(v[nat_k])
            if v.get(sim_k) is not None:
                s["similarity"].append(v[sim_k])
            if v.get(des_k) is not None:
                s["desirability"].append(v[des_k])

    def mean(lst):
        return round(sum(lst) / len(lst), 2) if lst else 0.0

    engine_b_stats = stats.get(ENGINE_B_ID, {})
    nat_b = mean(engine_b_stats.get("naturalness", []))
    sim_b = mean(engine_b_stats.get("similarity", []))
    des_b = mean(engine_b_stats.get("desirability", []))

    # Gate 1 criteria (Fabio 2026-09-10 v2)
    passes = des_b >= 7.0 and nat_b >= 6.5 and sim_b >= 6.0
    verdict = "PASS" if passes else "FAIL"

    return {
        "engine_b_in_test": ENGINE_B_ID,
        "sessions": len(pretest_sessions),
        "completed_sessions": sum(1 for s in pretest_sessions if s.get("completed_at")),
        "total_votes": len(votes),
        "engine_b_stats": {
            "naturalness_mean": nat_b,
            "similarity_mean": sim_b,
            "desirability_mean": des_b,
        },
        "engine_a_stats": {
            "naturalness_mean": mean(stats.get(ENGINE_A_ID, {}).get("naturalness", [])),
            "similarity_mean": mean(stats.get(ENGINE_A_ID, {}).get("similarity", [])),
            "desirability_mean": mean(stats.get(ENGINE_A_ID, {}).get("desirability", [])),
        },
        "gate_1_criteria": {
            "desirability_threshold": 7.0,
            "naturalness_threshold": 6.5,
            "similarity_threshold": 6.0,
        },
        "verdict": verdict,
        "next_action": (
            "Procedi al blind test integrale su 34 frasi (Gate 2)."
            if passes else
            f"Motore {ENGINE_B_ID} bocciato. Passa al motore successivo: "
            f"set env KODA_BLIND_TEST_ENGINE_B=megatts3_local_B (o xtts_v2_local_B) "
            f"e rigenera le clip. Se tutti e 3 falliscono → chiudiamo il "
            f"percorso locale ATTUALE (non conclude che TTS locale sia "
            f"impossibile in assoluto)."
        ),
    }
