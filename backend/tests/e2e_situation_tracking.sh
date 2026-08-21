#!/usr/bin/env bash
# e2e_situation_tracking.sh — Test end-to-end simulando Fabio via curl.
# Manda le 6 frasi al fast pipeline, polla la risposta, dump del DB dopo ognuna.

set -euo pipefail
BASE="${BASE:-http://localhost:8001/api}"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
h1() { echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${BLUE}▶ $1${NC}"; }

# STEP 0 — Preparazione: opt-in ON sul profilo default, wipe pulito
h1 "STEP 0 · Preparazione"
curl -s -X PUT "$BASE/profile" -H "Content-Type: application/json" \
  -d '{"settings":{"situation_tracking_enabled":true}}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  opt-in={d.get(\"settings\",{}).get(\"situation_tracking_enabled\")}')"
curl -s -X POST "$BASE/situations/wipe" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  wipe: sit={d.get(\"situations_deleted\")} ev={d.get(\"evidences_deleted\")}')"
curl -s -X DELETE "$BASE/memories" > /dev/null 2>&1 || true

# Batteria delle 6 frasi
FRASI=(
  "Ieri sera Carlo mi ha scritto un messaggio strano"
  "E stamattina Carlo ha aggiunto che vuole vederci"
  "Devo prepararmi per l'esame di storia di lunedì"
  "Mi sento un po' stanco e confuso oggi"
  "Alla fine con Carlo ci siamo chiariti, va meglio"
  "Che tempo fa oggi?"
)

for i in "${!FRASI[@]}"; do
  N=$((i+1))
  FRASE="${FRASI[$i]}"
  h1 "CASO $N · \"$FRASE\""

  # POST start (JSON payload via file per evitare escape apostrofi)
  PAYLOAD=$(python3 -c "import json; print(json.dumps({'text': '''$FRASE'''}))")
  SID=$(curl -s -X POST "$BASE/converse-fast/start" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))")

  if [ -z "$SID" ]; then
    echo -e "${RED}  ✗ session_id non ricevuto${NC}"
    continue
  fi
  echo "  session_id: $SID"

  # POLL finché arriva il meta
  SINCE=0
  for _ in $(seq 1 30); do
    RESP=$(curl -s "$BASE/converse-fast/poll/$SID?since=$SINCE&timeout=2.0")
    # Il poll ritorna events + next_since + done
    DONE=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('done',False))" 2>/dev/null || echo "False")
    NEXT=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('next_since',0))" 2>/dev/null || echo "$SINCE")
    SINCE=$NEXT
    if [ "$DONE" = "True" ]; then
      # Estrai il meta (contiene reply e situation_evidence se emesso)
      echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
events = d.get('events', [])
for ev in events:
    t = ev.get('type', '')
    if t == 'meta':
        reply = ev.get('reply', '')[:120]
        tone = ev.get('tone', '?')
        se = ev.get('situation_evidence')
        print(f'  reply: {reply!r}')
        print(f'  tone: {tone}')
        print(f'  situation_evidence: {se}')
"
      break
    fi
    sleep 0.3
  done

  sleep 0.5
  echo ""
  echo "  --- DB dopo il caso $N ---"
  python3 -c "
import asyncio, sys
sys.path.insert(0, '/app/backend')
from server import db, _SITUATIONS_COLL
async def main():
    sits = await db[_SITUATIONS_COLL].find({}, {'_id':0}).sort('last_evidence_at', -1).to_list(20)
    for s in sits:
        tags = ','.join(s.get('tags') or [])
        print(f'    • {s[\"entity\"]!r:25s} [{s[\"entity_type\"]:8s}] count={s[\"evidence_count\"]} tags=[{tags}]')
    if not sits: print('    (vuoto)')
asyncio.run(main())
" 2>&1 | grep -v Sentry | grep -v warn | grep -v ffmpeg | grep -v POC | grep -v Deep
  echo ""
done

h1 "SITUATION log finali"
tail -n 200 /var/log/supervisor/backend.err.log 2>/dev/null \
  | grep -E "\[situation\]|\[memory\] SKIP|\[situation_dedup\]" | tail -20
