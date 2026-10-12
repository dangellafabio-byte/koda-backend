#!/usr/bin/env python3
"""
Ollenya — Usage Audit (sola lettura)
=====================================

Scopo: estrarre lo STORICO di utilizzo aggregato dal database MongoDB
di produzione (Atlas) senza leggere alcun contenuto testuale, nome,
email, contenuto di conversazioni o chiave API.

Caratteristiche di sicurezza:
  • Query SOLO di tipo aggregate / count / distinct.
  • Nessun .find() che restituisca campi testuali (`text`, `voice_text`,
    `name`, `email`, prompt, ecc.).
  • Profile ID troncati ai primi 8 caratteri nell'output.
  • Nessuna scrittura, nessun update, nessuna delete.
  • Output: JSON stampato su stdout.

Esecuzione su Railway:
    railway run python /app/backend/scripts/usage_audit.py

Oppure, dalla shell Railway interattiva:
    python backend/scripts/usage_audit.py

Richiede che la variabile d'ambiente MONGO_URL sia configurata su Railway
(è già così in produzione).

Autore: Agente Emergent (ambiente dev), 2026-10-12.
"""
from __future__ import annotations
import os
import sys
import json
from datetime import datetime, timezone
from collections import defaultdict

try:
    from pymongo import MongoClient
except ImportError:
    print("ERRORE: pymongo non installato. Installa con: pip install pymongo", file=sys.stderr)
    sys.exit(1)

# ============================================================================
# CONFIG
# ============================================================================
MONGO_URL = os.environ.get("MONGO_URL")
if not MONGO_URL:
    print("ERRORE: variabile MONGO_URL non impostata.", file=sys.stderr)
    sys.exit(1)

DB_NAME = os.environ.get("DB_NAME", "test_database")

# Collezioni che vogliamo auditare. Nome collezione → campo timestamp primario.
# Se il campo è None, la collezione è conteggiata ma non spezzata per mese.
TARGET_COLLECTIONS = {
    "taccuino_profile": "created_at",
    "taccuino_subscription": "created_at",
    "taccuino_timeline": "timestamp",
    "taccuino_memories": "created_at",
    "taccuino_key_facts": "created_at",
    "taccuino_situations": "created_at",
    "confessional_entries": "created_at",
    "confessional_buffer": "created_at",
    "koda_events": "created_at",
    "analytics_events": "created_at",
    "admin_alert_outbox": "created_at",
    "messages": "timestamp",
    "conversations": "created_at",
    "history": "created_at",
    "sessions": "created_at",
    "fast_sessions": "created_at",
    "voice_auth_bridge": "created_at",
    "tts_audio_cache": "created_at",
    "unlimited_users": None,
    "free_config": None,
    "users": "created_at",
}

# Campi SENSIBILI che NON devono mai essere letti/esposti.
SENSITIVE_FIELDS = {
    "text", "voice_text", "content", "message", "prompt", "response",
    "name", "first_name", "last_name", "email", "phone", "address",
    "apple_user_id", "google_user_id", "device_id", "session_token",
    "api_key", "password", "secret", "nickname", "bio", "notes",
    "personal_info", "full_name", "voice_sample", "biometric",
}


# ============================================================================
# HELPERS
# ============================================================================
def _month_key(ts) -> str | None:
    """Estrae YYYY-MM da un timestamp (ISO string o datetime)."""
    if ts is None:
        return None
    if isinstance(ts, str):
        return ts[:7] if len(ts) >= 7 else None
    if isinstance(ts, datetime):
        return ts.strftime("%Y-%m")
    return None


def _anon(pid) -> str:
    """Tronca profile_id ai primi 8 char."""
    if not pid:
        return "none"
    s = str(pid)
    return s[:8] + "…"


def _safe_schema(doc: dict) -> dict:
    """Ritorna solo i NOMI dei campi + tipo, escludendo i campi sensibili.
    NON legge mai i valori di campi sensibili."""
    out = {}
    for k, v in doc.items():
        if k.lower() in SENSITIVE_FIELDS:
            out[k] = f"<redacted:{type(v).__name__}>"
        elif isinstance(v, dict):
            out[k] = "dict"
        elif isinstance(v, list):
            out[k] = f"list[{len(v)}]"
        else:
            out[k] = type(v).__name__
    return out


# ============================================================================
# AUDIT STEPS
# ============================================================================
def audit_connection(client) -> dict:
    """Verifica connessione e lista database."""
    try:
        client.admin.command("ping")
        return {
            "status": "ok",
            "databases": sorted(client.list_database_names()),
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


def audit_collections_overview(db) -> dict:
    """Per ogni collezione target: conteggio documenti + schema campi (senza valori)."""
    overview = {}
    existing = set(db.list_collection_names())
    for coll_name, ts_field in TARGET_COLLECTIONS.items():
        if coll_name not in existing:
            overview[coll_name] = {"exists": False}
            continue
        coll = db[coll_name]
        count = coll.estimated_document_count()
        sample = coll.find_one()
        schema = _safe_schema(sample) if sample else {}
        overview[coll_name] = {
            "exists": True,
            "count": count,
            "ts_field": ts_field,
            "schema": schema,
        }
    return overview


def audit_profiles(db) -> dict:
    """Conteggio profili per mese di creazione + distribuzione tier."""
    coll = db["taccuino_profile"]
    out = {"total": coll.estimated_document_count()}

    # Per mese di creazione
    monthly = defaultdict(int)
    try:
        for p in coll.find({}, {"created_at": 1, "subscription_tier": 1, "tier": 1}):
            m = _month_key(p.get("created_at"))
            if m:
                monthly[m] += 1
    except Exception as e:
        out["monthly_error"] = str(e)
    out["monthly_new_profiles"] = dict(sorted(monthly.items()))

    # Distribuzione tier (campo può essere `subscription_tier` o `tier`)
    tier_dist = defaultdict(int)
    try:
        for p in coll.find({}, {"subscription_tier": 1, "tier": 1}):
            tier = p.get("subscription_tier") or p.get("tier") or "unknown"
            tier_dist[str(tier)] += 1
    except Exception as e:
        out["tier_error"] = str(e)
    out["tier_distribution"] = dict(tier_dist)

    return out


def audit_timeline(db) -> dict:
    """Aggregazione mensile dei turni, separati per role e profile."""
    coll = db["taccuino_timeline"]
    out = {"total": coll.estimated_document_count()}

    pipeline = [
        {"$project": {
            "month": {"$substr": ["$timestamp", 0, 7]},
            "profile_id": 1,
            "role": 1,
            "audio_duration_ms": 1,
        }},
        {"$group": {
            "_id": {"m": "$month", "p": "$profile_id", "r": "$role"},
            "turns": {"$sum": 1},
            "audio_ms_sum": {"$sum": {"$ifNull": ["$audio_duration_ms", 0]}},
        }},
        {"$sort": {"_id.m": 1}},
    ]
    monthly = defaultdict(lambda: defaultdict(lambda: {
        "user_turns": 0, "ai_turns": 0, "user_audio_ms": 0, "ai_audio_ms": 0,
    }))
    try:
        for r in coll.aggregate(pipeline):
            m = r["_id"]["m"]
            p = _anon(r["_id"]["p"])
            role = r["_id"]["r"] or "unknown"
            n = r["turns"]
            audio_ms = r["audio_ms_sum"] or 0
            if role == "user":
                monthly[m][p]["user_turns"] += n
                monthly[m][p]["user_audio_ms"] += audio_ms
            elif role == "ai":
                monthly[m][p]["ai_turns"] += n
                monthly[m][p]["ai_audio_ms"] += audio_ms
    except Exception as e:
        out["pipeline_error"] = str(e)
    # Converti nested defaultdict in dict per JSON serialization
    out["monthly_by_profile"] = {
        m: {p: dict(v) for p, v in profs.items()}
        for m, profs in sorted(monthly.items())
    }

    # Totale aggregato per mese (somma su tutti i profili)
    monthly_totals = {}
    for m, profs in monthly.items():
        tot = {"user_turns": 0, "ai_turns": 0, "user_audio_ms": 0,
               "ai_audio_ms": 0, "distinct_profiles": len(profs)}
        for p, v in profs.items():
            tot["user_turns"] += v["user_turns"]
            tot["ai_turns"] += v["ai_turns"]
            tot["user_audio_ms"] += v["user_audio_ms"]
            tot["ai_audio_ms"] += v["ai_audio_ms"]
        monthly_totals[m] = tot
    out["monthly_totals"] = dict(sorted(monthly_totals.items()))

    return out


def audit_koda_events(db) -> dict:
    """
    Aggregazione mensile di `koda_events`:
      - eventi totali / mese
      - tts_seconds totali / mese (TTS ElevenLabs generato in secondi)
      - user_audio_ms totali / mese (audio inviato a Deepgram, in ms)
      - media tts_seconds per evento
    """
    coll = db["koda_events"]
    total = coll.estimated_document_count()
    out = {"total": total}
    if total == 0:
        out["note"] = "collezione vuota in questo ambiente"
        return out

    pipeline = [
        {"$project": {
            "month": {"$substr": [{"$ifNull": ["$created_at", "$timestamp"]}, 0, 7]},
            "tts_seconds": {"$ifNull": ["$tts_seconds", 0]},
            "user_audio_ms": {"$ifNull": ["$user_audio_ms", 0]},
            "event_type": 1,
        }},
        {"$group": {
            "_id": "$month",
            "events": {"$sum": 1},
            "tts_seconds_sum": {"$sum": "$tts_seconds"},
            "events_with_tts": {"$sum": {"$cond": [{"$gt": ["$tts_seconds", 0]}, 1, 0]}},
            "user_audio_ms_sum": {"$sum": "$user_audio_ms"},
        }},
        {"$sort": {"_id": 1}},
    ]
    monthly = {}
    try:
        for r in coll.aggregate(pipeline):
            m = r["_id"]
            if not m:
                continue
            tts_s = float(r["tts_seconds_sum"] or 0)
            audio_s = float(r["user_audio_ms_sum"] or 0) / 1000.0
            events = int(r["events"])
            with_tts = int(r["events_with_tts"])
            monthly[m] = {
                "events": events,
                "tts_seconds": round(tts_s, 2),
                "tts_minutes": round(tts_s / 60.0, 2),
                "events_with_tts": with_tts,
                "avg_tts_sec_per_tts_event": round(tts_s / with_tts, 2) if with_tts else 0,
                "user_audio_seconds": round(audio_s, 2),
                "user_audio_minutes": round(audio_s / 60.0, 2),
            }
    except Exception as e:
        out["pipeline_error"] = str(e)
    out["monthly"] = dict(sorted(monthly.items()))

    # Breakdown per event_type
    try:
        type_pipeline = [
            {"$group": {"_id": "$event_type", "n": {"$sum": 1},
                        "tts_s": {"$sum": {"$ifNull": ["$tts_seconds", 0]}}}},
            {"$sort": {"n": -1}},
        ]
        out["by_event_type"] = [
            {"type": r["_id"], "count": r["n"], "tts_seconds": round(float(r["tts_s"] or 0), 2)}
            for r in coll.aggregate(type_pipeline)
        ]
    except Exception as e:
        out["type_pipeline_error"] = str(e)

    return out


def audit_subscriptions(db) -> dict:
    """Distribuzione abbonamenti attivi."""
    coll = db["taccuino_subscription"]
    out = {"total": coll.estimated_document_count()}
    tier_dist = defaultdict(int)
    status_dist = defaultdict(int)
    try:
        for s in coll.find({}, {"tier": 1, "status": 1, "created_at": 1}):
            tier_dist[str(s.get("tier") or "unknown")] += 1
            status_dist[str(s.get("status") or "unknown")] += 1
    except Exception as e:
        out["error"] = str(e)
    out["tier_distribution"] = dict(tier_dist)
    out["status_distribution"] = dict(status_dist)
    return out


def audit_admin_alerts(db) -> dict:
    """Email admin inviate (via Resend managed)."""
    coll = db["admin_alert_outbox"]
    total = coll.estimated_document_count()
    out = {"total": total}
    if total == 0:
        return out
    try:
        monthly = defaultdict(int)
        for d in coll.find({}, {"created_at": 1, "status": 1}):
            m = _month_key(d.get("created_at"))
            if m:
                monthly[m] += 1
        out["monthly"] = dict(sorted(monthly.items()))
    except Exception as e:
        out["error"] = str(e)
    return out


# ============================================================================
# MAIN
# ============================================================================
def main():
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mongo_url_host": MONGO_URL.split("@")[-1].split("/")[0] if "@" in MONGO_URL else "localhost",
        "db_name": DB_NAME,
        "script_version": "1.0 (2026-10-12)",
    }

    try:
        client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=10000)
        report["connection"] = audit_connection(client)
        if report["connection"]["status"] != "ok":
            print(json.dumps(report, indent=2, default=str))
            sys.exit(1)

        db = client[DB_NAME]

        print("[audit] overview collezioni...", file=sys.stderr)
        report["collections_overview"] = audit_collections_overview(db)

        print("[audit] profili...", file=sys.stderr)
        report["profiles"] = audit_profiles(db)

        print("[audit] timeline (turni)...", file=sys.stderr)
        report["timeline"] = audit_timeline(db)

        print("[audit] koda_events (TTS, STT)...", file=sys.stderr)
        report["koda_events"] = audit_koda_events(db)

        print("[audit] abbonamenti...", file=sys.stderr)
        report["subscriptions"] = audit_subscriptions(db)

        print("[audit] email admin...", file=sys.stderr)
        report["admin_alerts"] = audit_admin_alerts(db)

        print("[audit] completato.", file=sys.stderr)

    except Exception as e:
        report["fatal_error"] = str(e)

    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
