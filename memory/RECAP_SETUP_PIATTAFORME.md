# 📋 Recap Setup "L'Amico Fraterno" — v2 (con web search)

> **Per Fabio** — versione aggiornata al 19 maggio 2026 dopo integrazione Tavily.

---

## 🍎 1) Apple Developer (apple.com/developer)
- 💰 €99/anno — account attivo
- 📱 Bundle ID: `com.lamicofraterno.app`
- 🔗 https://developer.apple.com/account
- 🔐 Da segnare: **Apple ID + Password + 2FA sull'iPhone**

## 🚀 2) Expo / EAS (expo.dev)
- 👤 Username: `fabiod.laboratory`
- 🆔 Progetto: `lamico-fraterno` (id: `5fbe8309-3108-4d11-8d53-4457df08d919`)
- 🔗 https://expo.dev/accounts/fabiod.laboratory/projects/lamico-fraterno
- 🔐 Da segnare: **username + password Expo**

## 📱 3) App da avere
- **L'Amico Fraterno (Dev)** — installa via QR di EAS
- Expo Go: NO
- TestFlight: in futuro per beta-test

---

## 🔑 4) API Keys (tutte sul server, in `/app/backend/.env`)

| Servizio | A cosa serve | Quota | Dove rinnovare |
|---|---|---|---|
| **Emergent LLM Key** | Cervello Claude | Universal | Dashboard Emergent |
| **Deepgram** | Voice→Testo (STT) | Free tier | https://console.deepgram.com |
| **ElevenLabs** | Voce Koda (TTS) | A consumo | https://elevenlabs.io/app/settings/api-keys |
| **Tavily** ✨NUOVO | Web search per Koda | **1.000 ricerche/mese gratis** | https://app.tavily.com |
| MongoDB | Database profilo | Locale | Niente — sul container |

## 🔐 5) Password DENTRO l'app (le sai SOLO tu)
- **Parola Segreta Confessionale** → NO recovery, è zero-knowledge
- **Voiceprint** → rifai dalle Impostazioni → ⋯ → "Rifai presentazione di Koda"

---

## 🎯 6) Funzionalità attive

### Identità Koda
- ✅ Voce **unica** consistente: default Sarah, o quella che scegli in Impostazioni — non cambia mai più tra intro/conversazione
- ✅ Eclissi (orb procedurale): blu petrolio quando registri, viola quando aspetta, ciclamino quando pensa
- ✅ Tema base "Eclissi": blu petrolio (utente) + viola (Koda)
- ✅ Banner verde "Configurazione salvata" dopo modifica profilo

### Confessionale
- ✅ Cifratura End-to-End (XSalsa20-Poly1305 / NaCl secretbox)
- ✅ Sfondo bordeaux (40% alpha) quando attivo
- ✅ Bubble bordeaux per Koda (le tue restano del colore tema)
- ✅ Memoria intra-sessione: Koda ricorda DENTRO il confessionale, dimentica FUORI
- ✅ Filtro privacy: bubble nascoste se confessionale OFF
- ✅ Tavily MAI attivo nel confessionale (privacy garantita)

### Web Search ✨NUOVO
- ✅ Koda può cercare info in tempo reale (notizie, prezzi, eventi, meteo, ecc.)
- ✅ Si attiva **automaticamente** quando rileva parole-chiave (oggi, ultimo, news, prezzo, ricetta, ecc.)
- ✅ Timeout 9s — se la rete è lenta, risponde lo stesso con info statiche
- ✅ Cita brevemente le fonti quando rilevanti

### Robustezza backend
- ✅ 2 worker uvicorn (no più schermo nero da hang singolo)
- ✅ Timeout 25s su Claude (anti-pianta)
- ✅ Watchdog frontend 30s (anti-spinner)
- ✅ Backend keep-alive 30s

### Onboarding Koda
- ✅ 10 step conversazionali (l'icona ⋯ in alto a destra lo riapre)
- ✅ Pulsante "Annulla" per uscire senza salvare
- ✅ Frasi voiceprint umane: "Buongiorno Koda...", "Stanotte non ho chiuso occhio...", "Dai, ridi anche tu..."
- ✅ Spiegazione capabilities (cosa Koda può/non può fare) nell'ultimo step

---

## 💰 7) COSTI MENSILI (uso personale ~1 ora/giorno)

| Servizio | Costo unitario | Stima/mese (uso medio) |
|---|---|---|
| Apple Developer | €99/anno | **€8.25/mese** |
| Expo Free tier | €0 | **€0** |
| Emergent LLM (Claude) | a consumo | **~€5-15/mese** |
| Deepgram | $0.0043/min STT | **~€2-5/mese** |
| ElevenLabs Starter | $5/mese (30k caratteri) | **€5/mese** |
| ElevenLabs Creator | $22/mese (100k caratteri) | €22/mese se serve |
| Tavily | 1.000 ricerche/mese GRATIS | **€0** (free tier) |
| Tavily oltre | $0.008/ricerca | €8/1000 extra |

**Stima totale uso personale**: **~€20-35/mese** (con ElevenLabs Starter)

**Se cresce a più utenti**: dipende dal piano abbonamento (sotto).

---

## 💵 8) PROPOSTA ABBONAMENTI UTENTI (quando pubblichi)

Sulla base dei costi reali, ecco 3 piani sostenibili:

### 🆓 Free
- 50 messaggi vocali/mese
- 10 ricerche web/mese
- Confessionale incluso (è "gratis" lato server)
- Voce: Sarah default (no scelta)
- **Costo per te**: ~€0.50/utente/mese

### 🌱 Plus (€4.99/mese)
- 500 messaggi vocali/mese
- 100 ricerche web/mese
- Scelta voce
- Confessionale + voiceprint
- **Costo per te**: ~€2.50/utente → margine ~50%

### 🌟 Premium (€9.99/mese)
- Conversazioni illimitate (fair use 3000/mese)
- 500 ricerche web/mese
- Tutte le voci ElevenLabs Premium
- Confessionale + voiceprint + check-in proattivi
- **Costo per te**: ~€5/utente → margine ~50%

### 🏆 Lifetime (€99 una tantum)
- Premium per sempre
- Solo nei primi 100 utenti early adopter
- Marketing: "vita per vita" 

**Break-even**: ~50 utenti Plus o ~25 Premium per coprire costi fissi (Apple+ElevenLabs+server).

---

## 🛠️ 9) Comandi rapidi (per quando torno qui)

| Cosa | Come |
|---|---|
| Riavviare backend | `sudo supervisorctl restart backend` |
| Riavviare Expo | `sudo supervisorctl restart expo` |
| Vedere log backend | `tail -n 50 /var/log/supervisor/backend.out.log` |
| Vedere log Expo | `tail -n 50 /var/log/supervisor/expo.out.log` |
| Nuovo build iOS | `cd /app/frontend && eas build --platform ios --profile development` |
| Test Tavily manuale | `curl -s -X POST -H "X-Api-Key: $TAVILY_API_KEY" https://api.tavily.com/search -d '{"query":"..."}'` |

---

## 📞 10) DA SEGNARE A MEMORIA (le 3 chiavi fondamentali)

1. **Apple ID + Password** (sblocca developer account + 2FA)
2. **Account Expo** (`fabiod.laboratory` + password)
3. **Parola Segreta del Confessionale** (NO recovery — è proprio così)

---

## 🚀 ROADMAP — Verso il rilascio pubblico

Prossimi step per arrivare in App Store:
1. ⏳ Voiceprint Iteration 2 (resemblyzer ML — riconoscimento voce proprietario)
2. ⏳ Push Notifications (`expo-notifications` + entitlement `aps-environment`)
3. ⏳ Modalità offline graceful (cache profilo, TTS fallback locale)
4. ⏳ Privacy Policy + Terms of Service (obbligatori per Apple)
5. ⏳ Build di produzione + TestFlight beta
6. ⏳ Submission App Store

---

*Ultimo aggiornamento: 19 maggio 2026 — sessione "Tavily integration"*
