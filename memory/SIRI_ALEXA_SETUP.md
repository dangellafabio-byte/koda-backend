# 🎤 Comandi Voce Esterni — Setup Siri & Alexa

## 🍎 SIRI — "Ehi Siri, parla con Coda"

### Cosa fa
Tieni il telefono in tasca / sui polsi (Apple Watch) / con AirPods. Dici *"Ehi Siri, parla con Coda"* e l'app si apre già in modalità voce attiva. Niente sblocco, niente tap.

### Limitazione attuale
SiriKit App Intents richiede un **development build** (NON Expo Go). Quando promuovi l'app a TestFlight/App Store, queste 2 cose si attivano:

### Passi (quando farai il dev build)
1. In `app.json` aggiungi:
   ```json
   {
     "expo": {
       "ios": {
         "bundleIdentifier": "com.tuonome.amicofraterno",
         "infoPlist": {
           "NSSiriUsageDescription": "Permette a Siri di aprire e parlare con Coda."
         }
       }
     }
   }
   ```
2. Installa il plugin SiriKit:
   ```bash
   npx expo install expo-siri-shortcuts
   ```
3. Aggiungi un "Intent" che invoca l'apertura dell'app sulla schermata voice. Il template è già pronto in `/app/frontend/ios-siri-intent.md` (TODO).
4. Costruisci con `eas build --platform ios --profile development`.

### Soluzione veloce SENZA dev build (oggi)
Puoi usare **Comandi Apple** (app preinstallata):
1. Apri *Comandi* su iPhone
2. Crea nuovo comando → "Apri app" → seleziona Expo Go (o la tua app)
3. Frase Siri → registra "Parla con Coda"
4. Ora *"Ehi Siri, parla con Coda"* apre l'app

---

## 🔊 ALEXA — Skill "Coda" su Echo

### Cosa fa
Sei in casa. Dici *"Alexa, apri Coda"* o *"Alexa, dì a Coda che mi sento stanco"*. L'Echo registra, manda al nostro backend, Coda risponde tramite l'Echo. iPhone NON serve.

### Setup (una tantum, ~15 min)

1. **Vai su [developer.amazon.com/alexa](https://developer.amazon.com/alexa/console/ask)** (account Amazon gratuito).

2. **Crea Skill**:
   - Click "Create Skill"
   - Name: **Coda** (o "Amico Fraterno")
   - Locale: **Italian (IT)**
   - Model: **Custom**
   - Hosting: **Provision your own**
   - Template: **Start from Scratch**

3. **Invocation name**: `coda` (o `amico fraterno` se preferisci)

4. **Endpoint → HTTPS**:
   - URL: `https://TUODOMINIO/api/alexa`
   - Certificate type: *My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority*

5. **Intents** (Skill Builder → JSON Editor → incolla questo):

```json
{
  "interactionModel": {
    "languageModel": {
      "invocationName": "coda",
      "intents": [
        { "name": "AMAZON.CancelIntent", "samples": [] },
        { "name": "AMAZON.HelpIntent", "samples": [] },
        { "name": "AMAZON.StopIntent", "samples": [] },
        {
          "name": "TalkIntent",
          "slots": [
            { "name": "query", "type": "AMAZON.SearchQuery" }
          ],
          "samples": [
            "dì che {query}",
            "dimmi {query}",
            "chiedi {query}",
            "{query}"
          ]
        }
      ],
      "types": []
    }
  }
}
```

6. **Save Model → Build Model** (1 min).

7. **Test tab → cambia "Off" in "Development"** → ora puoi testare con il tuo Echo (collegato allo stesso account Amazon).

8. **Prova**:
   - *"Alexa, apri Coda"* → "Ciao, sono qui. Cosa mi vuoi dire?"
   - *"Mi sento un po' giù oggi"* → Coda risponde via Echo
   - *"Alexa, stop"* → chiude

### Conferma tecnica
- Endpoint **già funzionante** (testato con request mock): vedi `/api/alexa`
- Bridge usa lo stesso `/api/converse` interno → **stessa memoria, stessi colori, stesso tutto**. Coda ti riconosce sia che parli al telefono sia all'Echo.
- Modalità Confessionale: **disponibile via Echo solo se configuri un secondo intent** (richiede sviluppo).

### Costi
- Account Amazon Developer: **gratuito**
- Skill personali: **gratuiti** illimitato per uso privato
- L'endpoint backend gira già sul tuo server → 0 extra
