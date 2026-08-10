/**
 * Route /setup-v2 — wrapper minimo per il guscio del nuovo Setup.
 *
 * Il componente vero è in components/KodaSetupV2.tsx. Questa file esiste
 * solo perché expo-router richiede un file dentro /app per esporre una URL.
 *
 * ATTENZIONE:
 *   - Route accessibile SOLO dal bottone admin in Impostazioni.
 *   - Non modifica il flusso di produzione (KodaIntro classico resta invariato).
 *   - Al termine del setup, redirect atomico verso /intro-v2 (Intro V2 già validata,
 *     nessuna modifica al suo comportamento).
 */

import React from "react";
import KodaSetupV2 from "../components/KodaSetupV2";

export default function SetupV2Route() {
  return <KodaSetupV2 />;
}
