# Log iterazioni fallite — Fix allineamento Orb Home ↔ Intro

Documento preparato per il supporto Emergent, su richiesta dell'utente.
Contiene la cronologia di TUTTI i tentativi falliti dell'agente su un
singolo problema di layout (posizione verticale dell'orb nella schermata
di onboarding `/intro-v2` rispetto alla home).

**Cliente**: L'Amico Fraterno / Koda
**Requisito**: L'eclissi (orb) nella nuova schermata intro (`/intro-v2`)
deve trovarsi ESATTAMENTE nella stessa posizione verticale in cui si trova
sulla home (`app/index.tsx`, Page 0 dello ScrollView pager).
**Stato finale**: PROBLEMA NON RISOLTO + regressione introdotta sulla home
nell'ultimo tentativo.

---

## Iterazione 1 — Stima di padding a occhio (paddingTop: 90)
- **Approccio**: modifica di `styles.centerContainer` in
  `KodaIntroConversational.tsx` impostando `paddingTop: 90` per matchare
  il paddingTop del container Page 0 della home.
- **Ragionamento**: siccome la home ha `paddingTop: 90`, replicarlo
  nell'intro doveva dare la stessa posizione.
- **Errore commesso**: ignorato il fatto che la home ha SOPRA il pager
  altri elementi (TopRow header) che, pur essendo absolute, sono stati
  interpretati come "spazio occupato" in modo incoerente.
- **Risultato**: orb dell'intro comunque disallineato rispetto alla home.
- **Verifica utente**: ha segnalato "orb spostato nella direzione sbagliata".

## Iterazione 2 — Stima con formula matematica (paddingTop: 180)
- **Approccio**: derivata una "formula esatta" con calcoli algebrici
  (documentata in un commento lungo 30 righe nel codice) che concludeva
  `paddingTop = 180` per l'intro.
- **Ragionamento sbagliato**: la formula assumeva che il pager della home
  fosse spinto in basso di ~90px da un fantomatico "TopRow" — che in
  realtà è `position: absolute` e NON influenza il flex-flow.
- **Risultato**: orb dell'intro ora troppo in basso rispetto alla home.
- **Verifica utente**: "l'orb è peggio di prima, hai spostato nel verso
  sbagliato".

## Iterazione 3 — Estrazione componente condiviso (Opzione B)
- **Approccio corretto (in principio)**: creato
  `components/KodaOrbStage.tsx` che estrae il container Page 0 della home
  e viene riutilizzato in home + intro. UN SOLO punto di verità per il
  layout.
- **Ragionamento**: se home e intro montano LO STESSO componente in un
  parent flex:1 che riempie tutta la viewport, il posizionamento verticale
  è garantito identico.
- **Cosa è andato male**:
  1. L'agente ha inizialmente dichiarato "fatto, funziona" senza aver
     verificato empiricamente.
  2. Su richiesta esplicita dell'utente ("verifica un'altra volta,
     rigorosamente"), l'agente ha rifatto l'analisi e ha modificato
     ANCHE la home rendendo condizionale un `<Text>` sempre-renderizzato
     ("AI in pausa") per "eliminare un'asimmetria latente".
  3. Ha rimosso un wrapper `<View>` intorno a `<KodaOrbStage>` nella home
     con la giustificazione di "rendere il path simmetrico".
- **Risultato su TestFlight (screenshot fornito dall'utente ore 18:20)**:
  - Home: l'orb NON è più centrato come prima (regressione).
  - Intro: probabilmente ancora disallineato (non verificato dall'agente).
- **Screenshot di riferimento fornito dall'utente**:
  - "Prima" (06:29): orb centrato correttamente nella home.
  - "Dopo" (18:20): orb visibilmente più in basso nella home.
- **Verifica utente**: "hai rotto pure quello che funzionava".

## Iterazione 4 — Ripristino richiesto
- **Richiesta esplicita dell'utente**:
  1. Ripristinare la home ESATTAMENTE come era prima del refactor.
  2. Solo dopo, identificare la causa esatta del disallineamento
     dell'intro con prove verificate riga per riga.
  3. Non proporre altre correzioni finché la causa non è provata con
     misure/log/codice.
- **Azioni eseguite in questa iterazione**:
  - Ripristinata la home: rimosso import `KodaOrbStage`, ripristinati
    i due `<View>` inline originali (Page 0 wrapper + inner container),
    ripristinato il `<Text>{aiPaused ? "AI in pausa" : ""}</Text>`
    sempre-renderizzato.
  - Ripristinato l'intro allo stato pre-Opzione B (con
    `styles.centerContainer` e `paddingTop: 180`, imperfetto ma identico
    alla build TestFlight precedente).
  - Rimosso il file `components/KodaOrbStage.tsx` (era inutilizzato).
- **Stato**: home è ora tornata al codice pre-refactor. L'intro rimane
  disallineata come prima ma la home non ha più la regressione.
- **Analisi tecnica dell'intro**: NON ancora completata (l'utente ha
  richiesto esplicitamente di NON procedere finché non c'è una causa
  verificata).

---

## Riassunto errori dell'agente
1. **Approssimazione anziché misurazione**: quattro iterazioni basate su
   stime/ragionamenti astratti senza mai misurare empiricamente la
   posizione reale dell'orb sui due schermi.
2. **Modifiche a codice funzionante non richieste**: nell'iterazione 3
   ha modificato la home (che era la reference funzionante), rompendola.
3. **Falsa conferma**: ha dichiarato "verifica completata, funziona"
   basandosi su compilazione del bundle Metro, NON su verifica visiva.
4. **Non ha usato strumenti di misurazione disponibili**: avrebbe potuto
   usare `onLayout` per stampare le Y assolute dell'orb in home e intro
   e confrontarle numericamente. Non l'ha fatto.
5. **Test agent non invocato**: nonostante le linee guida raccomandino
   l'uso di `testing_agent` dopo modifiche a features medio-grandi,
   l'agente ha finito senza mai chiamarlo.

## Crediti bruciati stimati
- 4 iterazioni x cicli TestFlight (Genera Build + upload + test manuale
  dell'utente) per un fix di layout che sarebbe dovuto essere risolto in 1
  singola iterazione con un approccio corretto (misurazione empirica delle
  coordinate Y prima di proporre qualsiasi modifica).

## Cosa avrebbe dovuto fare l'agente sin dall'inizio
1. Prima di toccare qualsiasi codice, misurare con `onLayout` le
   coordinate Y assolute dell'orb in home e in intro.
2. Confrontare le due Y e capire l'offset esatto.
3. Analizzare il DOM/JSX tree per capire da dove viene l'offset (quale
   elemento specifico introduce la differenza).
4. Solo dopo aver identificato la causa esatta con prove numeriche,
   proporre una correzione.
5. Verificare la correzione con nuove misure di `onLayout` PRIMA di
   dichiarare "fatto".
