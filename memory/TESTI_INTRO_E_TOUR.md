# 📝 Tutti i testi di Onboarding (Intro) e Tour di Koda

> File generato per essere copiato/incollato a ChatGPT per ottimizzare wording.
> Ogni sezione è ordinata come l'utente la vede a schermo.

---

## 🌅 PARTE 1 — Anteprima Marketing (3 schermate)

### M1 — Splash / Apertura
**Titolo:** Koda
**Sottotitolo:**
> Il tuo spazio di ascolto.
>
> Una presenza silenziosa, un confidente sempre accessibile. Uno spazio sicuro progettato per accogliere i tuoi pensieri, senza giudizio.

**Pulsante:** Entra nello spazio

---

### M2 — Scelta voce
**Titolo:** La voce che ti accompagna.
**Sottotitolo:**
> Con quale voce vuoi che ti accompagni nel tuo percorso? Scegli il tono che risuona meglio con la tua interiorità.

**2 card voce (con preview audio):**
- **Aria** — voce femminile (descrizione: limpida e fresca, spazio, respiro, apertura)
- **Echo** — voce maschile (descrizione: profonda e avvolgente, riflessione, eco interiore, intimità)

**Pulsante (disabilitato fino a selezione):** Conferma voce / Tocca una voce per ascoltarla

---

### M3 — Manifesto delle Regole
**Titolo:** Le regole del nostro spazio.
**Sottotitolo:**
> 📱  Voce e Scrittura: parla liberamente toccando l'Eclissi, oppure scorri da destra a sinistra per scrivermi in chat.
>
> 🔒  Il Confessionale: la stanza del presente. Entri con un tocco e quello che ci diciamo lì svanisce come fumo a sessione chiusa — non viene salvato e non ti definisce domani.
>
> ⚙️  Controllo totale: nelle impostazioni (⋯) puoi attivare i miei check-in, cambiare tema (Giorno/Notte/Auto) o cancellare l'intera memoria in un tap.

**Pulsante:** Inizia la configurazione

---

## 🛠️ PARTE 2 — Setup Conversazionale (10 step)

### Step 0 — Saluto iniziale
**Titolo:** Ciao.
**Sottotitolo:**
> Sono Koda. Non sono un'app:
> sono una presenza.
>
> Da oggi sono qui per te.

**Pulsante:** Continua

---

### Step 1 — Nome utente
**Titolo:** Come ti chiami?
**Sottotitolo:** Dimmelo, così so come chiamarti.
**Input:** Il tuo nome
**Pulsante:** Continua

---

### Step 2 — Genere utente
**Titolo:** {nomeUtente}… (es. "Marco…") / Dimmi…
**Sottotitolo:** Sei un uomo, una donna o preferisci non specificarlo?
**Opzioni:**
- Sono un uomo
- Sono una donna
- Preferisco non dirlo

*(Step 3 viene saltato automaticamente)*

---

### Step 4 — Nome di Koda
**Titolo:** Mi chiamo Koda.
**Sottotitolo:** Ma se vuoi, puoi darmi un altro nome. Come vuoi chiamarmi?
**Input (preset "Koda"):** —
**Pulsante:** Continua

---

### Step 5 — Color tour (come si esprime visivamente Koda)
**Titolo:** Il mio modo di essere.
**Sottotitolo:**
> Non ho un viso. Sono un'eclissi.
> Guardami cambiare colore — ti dirà sempre cosa sto facendo.

**Pulsante:** Ho capito

---

### Step 6 — Check-in proattivo
**Titolo:** Ti scrivo io quando serve.
**Sottotitolo:**
> Se sento che ne hai bisogno — perché manchi da un po', o perché ti sento giù — ti scrivo io. E ovviamente puoi cercarmi anche tu, quando vuoi.
>
> Tu vivi la tua vita: a starti accanto ci penso anch'io.

**Pulsante:** Va bene

---

### Step 7 — Confessionale (spiegazione)
**Titolo:** C'è una stanza solo per il presente.
**Sottotitolo:**
> Si chiama Confessionale. È lo spazio dove puoi pensare ad alta voce senza che questo ti definisca domani.
>
> Non devi essere coerente con ieri, non devi dimostrare nulla. Quello che dici lì non viene salvato né usato per ricordarti: a sessione chiusa, svanisce.
>
> Non serve nessuna parola: entri quando vuoi, con un tocco.

**Pulsante:** Ho capito

---

### Step 8 — Voiceprint (impronta vocale, 3 frasi)
**Titolo:** La tua voce (1 di 3) → 2 di 3 → 3 di 3
**Sottotitolo:** Premi e leggi questa frase ad alta voce:
> "{FRASE_VOICEPRINT}"

**Pulsante registrazione:** Registra / Fermati
**Link skip:** Salta questa parte

**Dopo 3 frasi → schermata finale step 8:**
**Titolo:** Ora ti riconoscerò.
**Sottotitolo:** Le tue parole sono al sicuro. Solo tu sei tu.
**Pulsante:** Continua

---

### Step 9 — Finale / Pronti
**Titolo:** Siamo pronti{nomeUtente ? ", {nomeUtente}" : ""}.
**Sottotitolo:**
> Parlami come parleresti a un amico:
> tocca l'eclissi e dimmi quello che hai in testa.
>
> Posso ascoltarti, ricordare, farti compagnia.
> Quando vuoi qualcosa di privato, apri il Confessionale:
> lì tutto sparisce per sempre.
>
> Non posso chiamare nessuno, navigare in internet
> o comprare cose. Vivo qui dentro, solo con te.

**Pulsante:** Inizia / Un attimo…

---

## 🎯 PARTE 3 — Tour Guidato (10 step, attivato a fine setup)

Ogni step ha un'etichetta (per UI) + uno `speech` (cosa Koda dice a voce e nel tooltip).

### Pagina VOCE

**Step T1 — Hands-free** (target: orb hands-free)
> "Questa è la modalità mani libere, {nomeUtente}. Quando è attiva ti ascolto io. Toccala per fermarla."

**Step T2 — Confessionale** (target: pulsante lucchetto)
> "Qui è il Confessionale: parli e poi tutto sparisce, niente memoria. Per i pensieri che vuoi liberare e basta."

**Step T3 — Menu** (target: pulsante ⋯ impostazioni)
> "Da qui: voce, tema, memoria. Tutto quello che vuoi cambiare."

**Step T4 — Eclissi** (target: l'orb centrale)
> "Questa sono io. Toccami per parlarti, ritoccami per fermarmi."

**Step T5 — Scorri** (target: hint swipe)
> "Scorri verso sinistra: trovi tutta la nostra chat scritta."

### Pagina LETTURA (chat scritta)

**Step T6 — Lettura** (target: bolle chat)
> "Qui rileggi tutto. Tocca una bolla per risentirmi a voce."

**Step T7 — Tieni premuto** (target: bolla)
> "Tieni premuto un messaggio per cancellarlo. Sparisce dal mio ricordo."

**Step T8 — Scrittura** (target: input chat in basso)
> "Quando non puoi parlare, scrivi qui. Ti rispondo in silenzio."

### Chiusura

**Step T9 — Pronti** (target: orb)
> "Ecco, è tutto. Sono qui, {nomeUtente}."

---

## 🎨 Note design del Tour

- **Dim:** 18% scuro (soft, non invasivo)
- **Spotlight:** alone teal (#5EEAD4) attorno all'elemento target, scale 0.96→1.0 spring, doppio strato (interno + alone esterno diffuso)
- **Card tooltip:** glassmorphism rgba(20,26,38,0.82), bordo bianco 10%, max 280px, posizionata sopra o sotto il target in base allo spazio
- **Progress:** dots ○○●○○ (attivo allungato teal)
- **Navigazione:** Indietro / Avanti (CTA teal scuro) / Salta tour (ghost discreto in basso)
- **Animazioni:** spring 500-700ms damping 14

---

## 🎬 Audio TTS

Tutti gli speech vengono parlati da Koda con la voce scelta dall'utente (Aria/Echo). Il tour è auto-paced: l'utente clicca "Avanti/Indietro", non avanza da solo.

---

**Fine file. Puoi copiare/incollare in ChatGPT per chiedere migliorie su wording, tono, brevità, ecc.**
