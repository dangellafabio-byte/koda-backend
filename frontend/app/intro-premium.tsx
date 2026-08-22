/**
 * /intro-premium — Route dell'Intro Premium (2026-08-22, Fabio).
 *
 * Attivata SOLO al primo boot di un utente Premium sulla home Koda
 * conversazionale ("/"). Il router condizionale in app/index.tsx
 * controlla `SecureStore.intro_premium_seen_at` (mirror di
 * Profile.intro_premium_seen_at) e reindirizza qui se assente.
 *
 * Dopo il completamento (voce + 3 coach-mark), il flag viene scritto
 * sia in SecureStore sia via POST /api/intro-premium/mark-seen
 * (persistenza server-side: sopravvive a reinstall e cambio device).
 *
 * NON tocca né la V1 (KodaIntro) né la V3 (KodaIntroV3). File-based
 * routing Expo, wrapper passthrough al componente.
 */
import React from "react";
import IntroPremium from "../components/IntroPremium";

export default function IntroPremiumScreen() {
  return <IntroPremium />;
}
