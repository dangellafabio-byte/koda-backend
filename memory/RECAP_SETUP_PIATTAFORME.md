# 📋 Recap Setup "L'Amico Fraterno" — Dove abbiamo messo cosa

> **Per Fabio** — questa è la tua mappa per non perderti mai più nelle varie piattaforme.

---

## 🍎 1) Apple Developer (apple.com / developer.apple.com)

**A che serve**: pubblicare/distribuire l'app su iPhone. Senza account Apple Developer non si può installare un'app fuori dall'App Store (a parte simulatore).

**Cosa hai fatto**:
- Account Apple Developer attivo (€99/anno)
- **Team ID**: visibile in https://developer.apple.com/account → "Membership details"
- **App Identifier creato**: `com.lamicofraterno.app` (il nostro Bundle ID)
- **Certificate iOS** + **Provisioning Profile (Development)** generati automaticamente da EAS quando hai fatto il primo build

**Dove guardare**:
- 🔗 https://developer.apple.com/account → Certificates, IDs & Profiles
- 🔗 https://appstoreconnect.apple.com → quando un giorno pubblichi su App Store

**Cosa ti devi segnare**:
- Apple ID (l'email)
- Password Apple ID
- Codice 2FA: ti arriva sull'iPhone quando fai login
- Team ID (lo recuperi sempre da Membership Details)

---

## 🚀 2) Expo / EAS (expo.dev)

**A che serve**: è il servizio che compila l'app iOS al posto tuo (al posto di Xcode). Fa il build "in cloud", firma con i certificati Apple, e ti dà il file `.ipa` o l'installazione diretta sul telefono.

**Cosa hai fatto**:
- Account Expo creato → **Username**: `fabiod.laboratory`
- Progetto EAS creato → **projectId**: `5fbe8309-3108-4d11-8d53-4457df08d919`
- Token EAS configurato sul server per fare i build

**Dove guardare**:
- 🔗 https://expo.dev/accounts/fabiod.laboratory/projects/lamico-fraterno
- Lì vedi tutti i build fatti, gli errori, i log, scaricare il QR

**Cosa ti devi segnare**:
- Username Expo: `fabiod.laboratory`
- Password Expo
- L'app sul tuo iPhone si chiama **"Expo Go"** (per testare in dev) MA noi non la usiamo
- Quello che usi tu è il **"Dev Build" personalizzato** dell'Amico Fraterno, installato direttamente sul telefono via EAS

---

## 📱 3) App da scaricare sul telefono

| App | Dove | A che serve |
|---|---|---|
| **L'Amico Fraterno (Dev)** | Installata via QR di EAS | È **la nostra app** in versione sviluppo |
| Expo Go | App Store | Non serve a noi (usiamo Dev Build) |
| TestFlight | App Store | Servirà quando faremo beta per altri (in futuro) |

**Come reinstallare la tua app se la cancelli**:
1. Vai su https://expo.dev/accounts/fabiod.laboratory/projects/lamico-fraterno/builds
2. Apri l'ultimo build iOS "internal distribution"
3. Inquadra il QR con la fotocamera dell'iPhone
4. "Apri" → "Installa" → fidati del certificato in Impostazioni → Generale → VPN e gestione dispositivo

---

## 🔑 4) API Keys (servizi esterni)

Tutto è salvato sul server in `/app/backend/.env` — **non devi più gestirle tu**.

| Servizio | A che serve | Dove rinnovare |
|---|---|---|
| **Emergent LLM Key** | Chiama Claude (l'intelligenza di Koda) — Universale | Dashboard Emergent (Profilo → Universal Key) |
| **Deepgram** | Speech-to-Text (trascrive quello che dici) | 🔗 https://console.deepgram.com → API Keys |
| **ElevenLabs** | Text-to-Speech (la voce di Koda) | 🔗 https://elevenlabs.io/app/settings/api-keys |
| MongoDB | Database del profilo (locale al server) | Niente da fare, gira sul container |

**Quando una di queste smette di funzionare** (es. Koda muta o non capisce):
- Controlla che la chiave sia ancora valida sul sito del servizio
- Se è scaduta, generane una nuova e dimmela in chat: la metto al posto giusto sul server

---

## 🔐 5) Password DENTRO l'app (Koda)

Queste sono password che **tu** hai impostato durante l'onboarding di Koda — non servono account esterni, vivono solo sul tuo telefono.

| Password | A che serve | Reset |
|---|---|---|
| **Parola Segreta del Confessionale** | Decifra la "Scatola Nera Emotiva". Solo tu la conosci. Il server NON la sa. | Se la dimentichi: NON c'è recupero, i confessionali passati sono persi (è il punto della Zero-Knowledge encryption) |
| **Voiceprint (la tua voce)** | Riconosce te quando apri l'app (futuro Iteration 2) | Puoi rifare l'enrollment dalle Impostazioni → tap su `⋯` → "Rifai la presentazione di Koda" |

---

## ⚙️ 6) Funzionalità configurate finora

- ✅ **Onboarding vocale** "Presentazione di Koda" (10 step, riapribile col tasto `⋯` in alto a destra)
- ✅ **Voiceprint enrollment** (3 frasi vocali registrate — file `.m4a` salvati sul server)
- ✅ **Confessionale** (Scatola Nera Emotiva) con cifratura E2E, sfondo bordeaux quando attivo
- ✅ **Memoria intra-confessionale** (Koda ricorda DENTRO al confessionale, dimentica FUORI)
- ✅ **Tema base "Eclissi"** (blu petrolio utente + viola Koda)
- ✅ **Streaming voice** con Claude + ElevenLabs + Deepgram
- ✅ **Timeout 25s anti-pianta backend**
- ✅ **Watchdog frontend 30s** (evita schermo nero / spinner infinito)

---

## 🛠️ 7) Comandi rapidi (per quando torno qui)

Se mai dovessi ricordarmi come si fanno cose veloci:

| Cosa | Come |
|---|---|
| Riavviare backend | `sudo supervisorctl restart backend` |
| Riavviare Expo | `sudo supervisorctl restart expo` |
| Vedere log backend | `tail -n 50 /var/log/supervisor/backend.out.log` |
| Vedere log Expo | `tail -n 50 /var/log/supervisor/expo.out.log` |
| Fare un nuovo build iOS | `cd /app/frontend && eas build --platform ios --profile development` |

---

## 📞 8) Riepilogo "cose da segnare a memoria"

**3 password fondamentali da NON perdere**:
1. **Apple ID + password** (sblocca developer account + 2FA)
2. **Account Expo (`fabiod.laboratory` + password)**
3. **Parola Segreta del Confessionale** (se la perdi, il confessionale è inaccessibile per sempre — è proprio così che deve essere)

**3 link da bookmark sul browser**:
- 🔗 https://expo.dev/accounts/fabiod.laboratory/projects/lamico-fraterno
- 🔗 https://developer.apple.com/account
- 🔗 https://console.deepgram.com / https://elevenlabs.io (solo se chiavi scadono)

---

*Ultimo aggiornamento: 19 maggio 2026 — `agent session`*
