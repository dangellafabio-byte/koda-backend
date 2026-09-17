/**
 * /intro-v3 — Route del "Cuore Intro" (2026-08-22, Fabio).
 *
 * v66.3 (Fabio 2026-06-16): sostituito OllenyaIntroV3 + AppWelcomeIntro
 * con OnboardingV4 unificato (spec 6-step).
 *
 * Attivata SOLO al primo boot: il router condizionale in app/index.tsx
 * controlla `SecureStore.intro_v3_completed_at`. Se assente, prima invia
 * a /legal-consent (disclaimer + checkbox) e poi qui. OnboardingV4
 * scrive il flag al termine (step 6) e naviga a /paywall.
 *
 * File-based routing Expo, wrapper passthrough al componente.
 */
import React from "react";
import OnboardingV4 from "../components/OnboardingV4";

export default function IntroV3Screen() {
  return <OnboardingV4 />;
}
