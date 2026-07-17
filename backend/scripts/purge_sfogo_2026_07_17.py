#!/usr/bin/env python3
"""
Purge one-shot: elimina tutte le entry della vecchia "Stanza dello Sfogo"
(campo confessional=true OPPURE fortezza=true) dalla collezione
taccuino_timeline.

Motivazione (Fabio 2026-07-17):
   La Stanza dello Sfogo è stata sostituita dalla nuova "Lascia andare",
   che è puramente locale (VAD sul dispositivo, zero rete, zero DB).
   Su richiesta esplicita dell'utente ("la memoria non dovrebbe esserci
   nemmeno... cancella tutto") si eliminano fisicamente TUTTE le
   entry della vecchia stanza rimaste in DB.

Esecuzione:
   python3 /app/backend/scripts/purge_sfogo_2026_07_17.py

Uscite:
   - Stampa quante entry sono state trovate/rimosse per tipo.
   - Idempotente: al secondo run i conteggi saranno 0.
"""
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

# Carica /app/backend/.env
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(env_path)


async def main():
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print(f"[purge] ERROR: MONGO_URL/DB_NAME mancanti in {env_path}")
        sys.exit(1)

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    coll = db.taccuino_timeline

    # Conta prima
    before_conf = await coll.count_documents({"confessional": True})
    before_fort = await coll.count_documents({"fortezza": True})
    before_any = await coll.count_documents(
        {"$or": [{"confessional": True}, {"fortezza": True}]}
    )
    print(
        f"[purge] TROVATE prima del purge → "
        f"confessional=True: {before_conf} | "
        f"fortezza=True: {before_fort} | "
        f"unione (deduplicata): {before_any}"
    )

    # Elimina tutte le entry marcate confessional OR fortezza
    res = await coll.delete_many(
        {"$or": [{"confessional": True}, {"fortezza": True}]}
    )
    print(f"[purge] Rimossi {res.deleted_count} documenti da taccuino_timeline.")

    # Verifica finale
    after_conf = await coll.count_documents({"confessional": True})
    after_fort = await coll.count_documents({"fortezza": True})
    print(
        f"[purge] Dopo il purge → "
        f"confessional=True: {after_conf} | "
        f"fortezza=True: {after_fort}"
    )

    if after_conf == 0 and after_fort == 0:
        print("[purge] OK — collezione ripulita.")
    else:
        print("[purge] WARN — restano entry marcate. Rilancia lo script.")

    client.close()


if __name__ == "__main__":
    asyncio.run(main())
