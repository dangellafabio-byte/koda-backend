// components/FreeOverlay.tsx
// -----------------------------------------------------------------------------
// v66.1 (Fabio 2026-06-16, feedback post-Build 41):
// L'overlay full-screen è stato RIMOSSO — bloccava lo swipe-right (chat) e
// oscurava troppo la home. Ora la componente è DEPRECATA/no-op: la logica
// "gate Free" è spostata inline nel render della home (index.tsx) — ogni
// elemento Premium (Eclissi, Hands-Free, Impostazioni) applica da solo lo
// stile "spento" e intercetta il proprio tap → showPremiumTeaser.
//
// Manteniamo l'export per backward-compat: qualunque render residuo con
// FreeOverlay è ora un no-op silenzioso, così la migrazione è progressiva
// senza rompere i callsite esistenti.
// -----------------------------------------------------------------------------

import React from "react";

export interface FreeOverlayProps {
  onTap?: () => void;
  visible?: boolean;
}

export default function FreeOverlay(_props: FreeOverlayProps) {
  // No-op. Vedi commento in testa al file.
  return null;
}
