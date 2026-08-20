/**
 * /intro-v3 — Route del "Cuore Intro" (2026-08-22, Fabio).
 *
 * Attivata SOLO al primo boot: il router condizionale in app/index.tsx
 * controlla `SecureStore.intro_v3_completed_at` e reindirizza qui se
 * assente. Dopo il completamento, la sequenza narrativa non si ripete
 * MAI più (dalla seconda apertura in poi → LA direttamente).
 *
 * File-based routing Expo, wrapper passthrough al componente.
 */
import React from "react";
import KodaIntroV3 from "../components/KodaIntroV3";

export default function IntroV3Screen() {
  return <KodaIntroV3 />;
}
