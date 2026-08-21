#!/usr/bin/env bash
# situations_inspector.sh — Ispeziona lo stato del Situation Tracking.
#
# Uso:
#   ./situations_inspector.sh                # dump completo
#   ./situations_inspector.sh --enable       # attiva opt-in
#   ./situations_inspector.sh --disable      # disattiva opt-in
#   ./situations_inspector.sh --wipe         # cancella tutto (idempotente)
#   ./situations_inspector.sh --logs         # ultimi 200 log [situation]/[memory]/[situation_dedup]
#   ./situations_inspector.sh --detail <id>  # dettaglio situation + evidences

set -euo pipefail

BASE="${BASE:-https://app-finder-408.preview.emergentagent.com/api}"
CMD="${1:-status}"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'

hr() { echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }
h1() { hr; echo -e "${BLUE}▶ $1${NC}"; hr; }

case "$CMD" in
  --enable)
    h1 "Attivo opt-in Situation Tracking"
    curl -s -X PUT "$BASE/profile" -H "Content-Type: application/json" \
      -d '{"settings":{"situation_tracking_enabled":true}}' \
      | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('settings',{}); print(f'✓ enabled = {s.get(\"situation_tracking_enabled\")}')"
    ;;
  --disable)
    h1 "Disattivo opt-in"
    curl -s -X PUT "$BASE/profile" -H "Content-Type: application/json" \
      -d '{"settings":{"situation_tracking_enabled":false}}' \
      | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('settings',{}); print(f'✓ enabled = {s.get(\"situation_tracking_enabled\")}')"
    ;;
  --wipe)
    h1 "Wipe situations + evidences"
    curl -s -X POST "$BASE/situations/wipe" | python3 -m json.tool
    ;;
  --logs)
    h1 "Ultimi 200 log rilevanti (backend)"
    tail -n 400 /var/log/supervisor/backend.err.log 2>/dev/null \
      | grep -E "\[situation\]|\[memory\]|\[situation_dedup\]" \
      | tail -60 || echo "(nessun log ancora)"
    ;;
  --detail)
    SID="${2:?serve situation_id}"
    h1 "Dettaglio situation $SID"
    curl -s "$BASE/situations/$SID" | python3 -m json.tool
    ;;
  *)
    # Dump completo
    h1 "STATUS"
    curl -s "$BASE/situations/status" | python3 -m json.tool

    echo ""
    h1 "SITUATIONS (attive, non archiviate)"
    curl -s "$BASE/situations?limit=100" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('enabled'):
    print('  ⚠️  opt-in OFF — usa --enable prima')
    sys.exit(0)
sits = d.get('situations', [])
if not sits:
    print('  (nessuna situation)')
else:
    print(f'  Totale: {len(sits)}')
    for s in sits:
        muted = ' 🔇' if s.get('user_muted') else ''
        arch = ' 📦' if s.get('archived_at') else ''
        tags = ', '.join(s.get('tags') or [])
        print(f'  • [{s[\"entity_type\"]:8s}] {s[\"title\"]:20s}  count={s[\"evidence_count\"]}  tags=[{tags}]{muted}{arch}')
        print(f'    id={s[\"id\"]}  last={s[\"last_evidence_at\"][:19]}')
"

    echo ""
    h1 "ULTIMI LOG [situation*] (backend)"
    tail -n 500 /var/log/supervisor/backend.err.log 2>/dev/null \
      | grep -E "\[situation\]|\[situation_dedup\]|\[memory\] SKIP" \
      | tail -20 || echo "  (nessun log ancora)"
    ;;
esac
