/**
 * /intro-v3 — Route del "Cuore Intro" (2026-08-22, Fabio).
 *
 * Attivata SOLO al primo boot: il router condizionale in app/index.tsx
 * controlla `SecureStore.intro_v3_completed_at` e reindirizza qui se
 * assente. Dopo il completamento, la sequenza narrativa non si ripete
 * MAI più (dalla seconda apertura in poi → LA direttamente).
 *
 * === v66.2 (Fabio 2026-06-16): Cornice narrativa aggiunta ===
 * PRIMA di OllenyaIntroV3 (intro vocale) mostriamo `AppWelcomeIntro`:
 * 3 slide swipeable che spiegano cos'è Ollenya. Feedback utente:
 * "non c'è un'introduzione vera e propria dell'app" → risolto qui.
 * Flag locale (useState) per il handoff: nessun SecureStore aggiuntivo.
 *
 * File-based routing Expo, wrapper passthrough al componente.
 */
import React, { useState } from "react";
import OllenyaIntroV3 from "../components/OllenyaIntroV3";
import AppWelcomeIntro from "../components/AppWelcomeIntro";

export default function IntroV3Screen() {
  // welcomeDone=false → mostra le 3 slide welcome.
  // welcomeDone=true  → hand-off a OllenyaIntroV3 (intro vocale).
  // Il flag non è persistente: se l'utente esce a metà del welcome e
  // rientra, rivede il welcome. Volutamente non-persistente per evitare
  // il rischio di skippare la spiegazione se l'app viene killata.
  const [welcomeDone, setWelcomeDone] = useState(false);

  if (!welcomeDone) {
    return <AppWelcomeIntro onDone={() => setWelcomeDone(true)} />;
  }
  return <OllenyaIntroV3 />;
}
