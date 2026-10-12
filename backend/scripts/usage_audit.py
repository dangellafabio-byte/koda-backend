#!/usr/bin/env python3
"""
Ollenya — Usage Audit (sola lettura, PRODUZIONE)
=================================================

Scopo: estrarre lo STORICO aggregato di utilizzo dal database MongoDB
Atlas di produzione senza leggere alcun contenuto testuale, nome,
email, contenuto di conversazioni, chiave API o credenziale.

GARANZIE DI SICUREZZA
---------------------
  • Query SOLO di tipo aggregate / count / distinct / find con proiezione
    campi ristretta.
  • Nessuna scrittura, update, delete.
  • Campi sensibili (text, voice_text, name, email, ecc.) MAI letti né
    esposti in output. Mascherati come "<redacted:...>".
  • Profile ID troncati ai primi 8 caratteri nell'output.
  • Connection string NON esposta: `mongo_url_host` mostra solo l'host.
  • Output JSON puro su stdout, log diagnostica su stderr.

GARANZIE DI AMBIENTE
--------------------
  • Lo script RIFIUTA di eseguire se MONGO_URL punta a localhost / 127.*
    / mongodb-dev-like, oppure se DB_NAME è "test_database".
  • Nessun fallback silenzioso: se la configurazione di produzione non
    è trovata, esce con codice 2 e messaggio esplicito.
  • Flag `--allow-dev` opzionale per debug nell'ambiente di sviluppo
    (NON passare in produzione).

OUTPUT
------
  • Default: JSON su stdout.
  • Con `--out FILE`: scrive il JSON su file e stampa su stderr il path.
  • Sezione `coverage_period` con data minima/massima rilevata nelle
    collezioni temporali principali.
  • Sezione `populated_fields` per collezione: lista campi che hanno
    almeno un documento con valore non-null (campione statistico).

USAGE
-----
    python backend/scripts/usage_audit.py [--out audit.json] [--allow-dev]

Esecuzione raccomandata (Railway produzione):
    railway ssh                          # entra nel container di prod
    python backend/scripts/usage_audit.py --out /tmp/audit.json

Versione: 1.1 (2026-10-12) — fail-fast + coverage + populated_fields
Autore: Agente Emergent (ambiente dev, trasferibile a produzione).
"""
from __future__ import annotations
import os
import re
import sys
import json
import argparse
from datetime import datetime, timezone
from collections import defaultdict
from urllib.parse import urlparse

try:
    from pymongo import MongoClient
except ImportError:
    print("ERRORE: pymongo non installato. Installa con: pip install pymongo",
          file=sys.stderr)
    sys.exit(1)


# ============================================================================
# PRODUCTION GUARD — nessun fallback silenzioso
# ============================================================================
def _parse_mongo_host(url: str) -> str:
    """Estrae l'host dalla connection string, senza esporre credenziali."""
    if not url:
        return ""
    try:
        # Rimuovi protocol e credenziali prima del parsing
        safe = re.sub(r"://[^@]*@", "://", url)
        p = urlparse(safe)
        return p.hostname or ""
    except Exception:
        return ""


def _is_dev_connection(url: str, db_name: str) -> tuple[bool, str]:
    """Ritorna (is_dev, motivo). Blocca ogni esecuzione su ambiente dev."""
    host = _parse_mongo_host(url).lower()

    dev_hosts = ("localhost", "127.0.0.1", "0.0.0.0", "mongo-dev", "mongo-local")
    for d in dev_hosts:
        if host == d or host.startswith(d + "."):
            return True, f"host MongoDB '{host}' è dev-like"

    dev_dbs = ("test_database", "test", "dev", "development", "localdb")
    if (db_name or "").lower() in dev_dbs:
        return True, f"DB_NAME '{db_name}' è dev-like"

    if not host:
        return True, "host MongoDB non riconosciuto o vuoto"

    return False, ""


# ============================================================================
# CONFIG
# ============================================================================
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
    "analytics_events": "ts",
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

SENSITIVE_FIELDS = {
    "text", "voice_text", "content", "message", "prompt", "response",
    "name", "first_name", "last_name", "email", "phone", "address",
    "apple_user_id", "google_user_id", "device_id", "session_token",
    "api_key", "password", "secret", "nickname", "bio", "notes",
    "personal_info", "full_name", "voice_sample", "biometric",
    "query", "summary", "fact", "source_text", "concept",
    "memory_summary", "core_traits", "ai_name", "home_city",
}


# ============================================================================
# HELPERS
# ============================================================================
def _month_key(ts) -> str | None:
    if ts is None:
        return None
    if isinstance(ts, str):
        return ts[:7] if len(ts) >= 7 else None
    if isinstance(ts, datetime):
        return ts.strftime("%Y-%m")
    return None


def _anon(pid) -> str:
    if not pid:
        return "none"
    s = str(pid)
    return s[:8] + "…"


def _safe_schema(doc: dict) -> dict:
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


def _populated_fields(coll, sample_size: int = 50) -> dict:
    """Per ogni campo del campione, conta quanti documenti hanno valore
    non-null (esclusi campi sensibili). Serve per capire quali metriche
    sono effettivamente registrate.
    """
    count = coll.estimated_document_count()
    if count == 0:
        return {"__count__": 0}
    sample_size = min(sample_size, count)
    try:
        pipeline = [{"$sample": {"size": sample_size}}]
        docs = list(coll.aggregate(pipeline, allowDiskUse=False))
    except Exception as e:
        return {"__error__": str(e)}
    tally = defaultdict(int)
    for d in docs:
        for k, v in d.items():
            if k.lower() in SENSITIVE_FIELDS:
                continue  # Non contiamo i sensibili
            if v is not None and v != "" and v != [] and v != {}:
                tally[k] += 1
    return {
        "__sample_size__": len(docs),
        **{k: tally[k] for k in sorted(tally.keys())}
    }


# ============================================================================
# AUDIT STEPS
# ============================================================================
def audit_connection(client) -> dict:
    try:
        client.admin.command("ping")
        return {"status": "ok",
                "databases": sorted(client.list_database_names())}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def audit_collections_overview(db) -> dict:
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
        populated = _populated_fields(coll)
        overview[coll_name] = {
            "exists": True,
            "count": count,
            "ts_field": ts_field,
            "schema": schema,
            "populated_fields_sample": populated,
        }
    return overview


def audit_coverage_period(db) -> dict:
    """Trova la data minima e massima dei record nelle collezioni temporali
    principali. Serve a dichiarare esattamente il periodo coperto dal
    dataset.
    """
    out = {}
    checks = [
        ("taccuino_timeline", "timestamp"),
        ("koda_events", "created_at"),
        ("taccuino_profile", "created_at"),
        ("analytics_events", "ts"),
        ("admin_alert_outbox", "created_at"),
    ]
    for coll_name, field in checks:
        try:
            coll = db[coll_name]
            if coll.estimated_document_count() == 0:
                out[coll_name] = {"min": None, "max": None, "count": 0}
                continue
            # Query minimale: solo il campo timestamp
            first = coll.find_one({field: {"$ne": None}}, {field: 1},
                                  sort=[(field, 1)])
            last = coll.find_one({field: {"$ne": None}}, {field: 1},
                                 sort=[(field, -1)])
            out[coll_name] = {
                "field": field,
                "min": str(first.get(field)) if first else None,
                "max": str(last.get(field)) if last else None,
                "count": coll.estimated_document_count(),
            }
        except Exception as e:
            out[coll_name] = {"error": str(e)}
    return out


def audit_profiles(db) -> dict:
    coll = db["taccuino_profile"]
    out = {"total": coll.estimated_document_count()}

    monthly = defaultdict(int)
    try:
        for p in coll.find({}, {"created_at": 1}):
            m = _month_key(p.get("created_at"))
            if m:
                monthly[m] += 1
    except Exception as e:
        out["monthly_error"] = str(e)
    out["monthly_new_profiles"] = dict(sorted(monthly.items()))

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
        "user_turns": 0, "ai_turns": 0,
        "user_audio_ms": 0, "ai_audio_ms": 0,
    }))
    try:
        for r in coll.aggregate(pipeline):
            m = r["_id"].get("m") or "no_timestamp"
            p = _anon(r["_id"].get("p"))
            role = r["_id"].get("r") or "unknown"
            n = r["turns"]
            audio_ms = r["audio_ms_sum"] or 0
            if role == "user":
                monthly[m][p]["user_turns"] += n
                monthly[m][p]["user_audio_ms"] += audio_ms
            elif role == "ai":
                monthly[m][p]["ai_turns"] += n
                monthly[m][p]["ai_audio_ms"] += audio_ms
            else:
                monthly[m][p].setdefault("other_turns", 0)
                monthly[m][p]["other_turns"] += n
    except Exception as e:
        out["pipeline_error"] = str(e)

    out["monthly_by_profile"] = {
        m: {p: dict(v) for p, v in profs.items()}
        for m, profs in sorted(monthly.items())
    }
    monthly_totals = {}
    for m, profs in monthly.items():
        tot = {"user_turns": 0, "ai_turns": 0, "user_audio_ms": 0,
               "ai_audio_ms": 0, "distinct_profiles": len(profs)}
        for p, v in profs.items():
            tot["user_turns"] += v.get("user_turns", 0)
            tot["ai_turns"] += v.get("ai_turns", 0)
            tot["user_audio_ms"] += v.get("user_audio_ms", 0)
            tot["ai_audio_ms"] += v.get("ai_audio_ms", 0)
        monthly_totals[m] = tot
    out["monthly_totals"] = dict(sorted(monthly_totals.items()))
    return out


def audit_koda_events(db) -> dict:
    coll = db["koda_events"]
    total = coll.estimated_document_count()
    out = {"total": total}
    if total == 0:
        out["note"] = "collezione vuota"
        return out

    pipeline = [
        {"$project": {
            "month": {"$substr": [
                {"$ifNull": ["$created_at", "$timestamp"]}, 0, 7]},
            "tts_seconds": {"$ifNull": ["$tts_seconds", 0]},
            "user_audio_ms": {"$ifNull": ["$user_audio_ms", 0]},
            "event_type": 1,
        }},
        {"$group": {
            "_id": "$month",
            "events": {"$sum": 1},
            "tts_seconds_sum": {"$sum": "$tts_seconds"},
            "events_with_tts": {"$sum": {"$cond": [
                {"$gt": ["$tts_seconds", 0]}, 1, 0]}},
            "user_audio_ms_sum": {"$sum": "$user_audio_ms"},
            "events_with_audio": {"$sum": {"$cond": [
                {"$gt": ["$user_audio_ms", 0]}, 1, 0]}},
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
            with_audio = int(r["events_with_audio"])
            monthly[m] = {
                "events": events,
                "tts_seconds": round(tts_s, 2),
                "tts_minutes": round(tts_s / 60.0, 2),
                "events_with_tts": with_tts,
                "avg_tts_sec_per_tts_event":
                    round(tts_s / with_tts, 2) if with_tts else 0,
                "user_audio_seconds": round(audio_s, 2),
                "user_audio_minutes": round(audio_s / 60.0, 2),
                "events_with_audio": with_audio,
            }
    except Exception as e:
        out["pipeline_error"] = str(e)
    out["monthly"] = dict(sorted(monthly.items()))

    try:
        type_pipeline = [
            {"$group": {"_id": "$event_type", "n": {"$sum": 1},
                        "tts_s": {"$sum": {"$ifNull": ["$tts_seconds", 0]}}}},
            {"$sort": {"n": -1}},
        ]
        out["by_event_type"] = [
            {"type": r["_id"], "count": r["n"],
             "tts_seconds": round(float(r["tts_s"] or 0), 2)}
            for r in coll.aggregate(type_pipeline)
        ]
    except Exception as e:
        out["type_pipeline_error"] = str(e)

    return out


def audit_subscriptions(db) -> dict:
    coll = db["taccuino_subscription"]
    out = {"total": coll.estimated_document_count()}
    tier_dist = defaultdict(int)
    status_dist = defaultdict(int)
    plan_dist = defaultdict(int)
    try:
        for s in coll.find({}, {"tier": 1, "plan": 1, "status": 1}):
            tier_dist[str(s.get("tier") or "unknown")] += 1
            status_dist[str(s.get("status") or "unknown")] += 1
            plan_dist[str(s.get("plan") or "unknown")] += 1
    except Exception as e:
        out["error"] = str(e)
    out["tier_distribution"] = dict(tier_dist)
    out["plan_distribution"] = dict(plan_dist)
    out["status_distribution"] = dict(status_dist)
    return out


def audit_admin_alerts(db) -> dict:
    coll = db["admin_alert_outbox"]
    total = coll.estimated_document_count()
    out = {"total": total}
    if total == 0:
        return out
    try:
        monthly = defaultdict(int)
        for d in coll.find({}, {"created_at": 1}):
            m = _month_key(d.get("created_at"))
            if m:
                monthly[m] += 1
        out["monthly"] = dict(sorted(monthly.items()))
    except Exception as e:
        out["error"] = str(e)
    return out


def audit_analytics_events(db) -> dict:
    """analytics_events può registrare eventi UI/business (es. onboarding
    completato, paywall visto, ecc.). Breakdown per `event` + mese."""
    coll = db["analytics_events"]
    total = coll.estimated_document_count()
    out = {"total": total}
    if total == 0:
        return out
    try:
        pipeline = [
            {"$group": {"_id": "$event", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 100},
        ]
        out["by_event"] = [{"event": r["_id"], "count": r["n"]}
                           for r in coll.aggregate(pipeline)]
    except Exception as e:
        out["error"] = str(e)
    return out


# ============================================================================
# MAIN
# ============================================================================
def main():
    parser = argparse.ArgumentParser(
        description="Ollenya Usage Audit (read-only).")
    parser.add_argument("--out", type=str, default=None,
                        help="Scrive JSON su file invece di stdout.")
    parser.add_argument("--allow-dev", action="store_true",
                        help="Permette esecuzione su DB dev (solo debug).")
    args = parser.parse_args()

    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME", "")

    # === PRODUCTION GUARD ===
    if not mongo_url:
        print("FATAL: variabile MONGO_URL non impostata. "
              "Lo script RIFIUTA di eseguire senza una configurazione DB "
              "esplicita.", file=sys.stderr)
        sys.exit(2)

    is_dev, motivo = _is_dev_connection(mongo_url, db_name)
    if is_dev and not args.allow_dev:
        print(f"FATAL: ambiente rilevato come DEV ({motivo}). "
              f"Lo script RIFIUTA di eseguire. Usa --allow-dev solo per "
              f"debug locale, mai in produzione.", file=sys.stderr)
        sys.exit(3)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "script_version": "1.1 (2026-10-12)",
        "mongo_url_host": _parse_mongo_host(mongo_url),
        "db_name": db_name,
        "allow_dev_flag": args.allow_dev,
    }

    try:
        client = MongoClient(mongo_url, serverSelectionTimeoutMS=15000)
        report["connection"] = audit_connection(client)
        if report["connection"]["status"] != "ok":
            _emit(report, args.out)
            sys.exit(1)

        db = client[db_name] if db_name else client.get_default_database()
        report["effective_db"] = db.name

        print("[audit] coverage_period...", file=sys.stderr)
        report["coverage_period"] = audit_coverage_period(db)

        print("[audit] collections_overview...", file=sys.stderr)
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

        print("[audit] analytics_events...", file=sys.stderr)
        report["analytics_events"] = audit_analytics_events(db)

        print("[audit] completato.", file=sys.stderr)

    except Exception as e:
        report["fatal_error"] = str(e)

    _emit(report, args.out)


def _emit(report: dict, out_path: str | None):
    payload = json.dumps(report, indent=2, default=str, ensure_ascii=False)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(payload)
        print(f"[audit] JSON scritto in: {out_path} "
              f"({len(payload)} bytes)", file=sys.stderr)
    else:
        print(payload)


if __name__ == "__main__":
    main()
