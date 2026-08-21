#!/usr/bin/env bash
# check_production_situations.sh — Dopo che hai parlato con Koda su Expo Go,
# lancia questo script per vedere cosa Koda ha registrato in produzione.
#
# Uso: /app/backend/tests/check_production_situations.sh
#
# NOTA: gli endpoint /api/situations/* di produzione filtrano per profile_id
# dell'utente autenticato. Da curl senza auth vediamo il profilo "me" (default),
# che è vuoto per te. Per vedere il TUO profilo Fabio in produzione, servirebbe
# il tuo session token — che è sull'iPhone.
#
# Quello che possiamo fare da qui: verificare i LOG del backend produzione
# non abbiamo accesso (K8s di Emergent, non i nostri log). Quindi:
# 1. Verificare che gli endpoint rispondano (sanity check deploy)
# 2. Chiederti a voce cosa Koda ti ha detto per sapere se ha "riconosciuto"
#    Carlo e l'esame nei turni successivi

PROD="https://app-finder-408.emergent.host/api"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
h1() { echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${BLUE}▶ $1${NC}"; }

h1 "1. Sanity check endpoint Situation Tracking in produzione"
echo "  /situations/status (profilo default, senza auth):"
curl -s "$PROD/situations/status" | python3 -m json.tool | sed 's/^/    /'

echo ""
echo "  /situations lista (profilo default):"
curl -s "$PROD/situations?limit=20" | python3 -m json.tool | head -6 | sed 's/^/    /'

h1 "2. Verifica che la UI Settings sia deployata"
echo "  L'app in produzione deve avere il toggle 🧭 'Cosa Koda ricorda' visibile."
echo "  Se lo vedi nell'app Expo Go: UI deploy OK."

h1 "3. Come sapere se il tuo profilo ha registrato le situations"
echo -e "${YELLOW}"
echo "  Il DB di produzione non è accessibile da qui (K8s Emergent)."
echo "  Ma puoi verificarlo TU, direttamente dall'app:"
echo ""
echo "    a) Attiva il toggle 🧭 'Cosa Koda ricorda' nelle Impostazioni"
echo "    b) Parla con Koda le tue 6 frasi (Carlo, esame, ecc)"
echo "    c) Chiedile A VOCE: 'Cosa ricordi di me?' oppure 'Chi è Carlo?'"
echo "       Se ha registrato correttamente, sa che Carlo è una persona"
echo "       menzionata e non ti chiede più chi è."
echo ""
echo "  In alternativa, apri Safari sull'iPhone e vai a:"
echo -e "${GREEN}    https://app-finder-408.emergent.host/api/situations?limit=20${NC}"
echo -e "${YELLOW}"
echo "  Se sei autenticato nel browser (session cookie condiviso con l'app):"
echo "    → vedrai le TUE situations. Screenshot e mandami quello."
echo "  Se non sei autenticato:"
echo "    → vedrai una risposta vuota (come mostrato sopra al punto 1)"
echo -e "${NC}"
