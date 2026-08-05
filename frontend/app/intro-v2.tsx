/**
 * /intro-v2 — Route isolata per testing dell'onboarding conversazionale.
 * File-based routing Expo. Il wrapper è solo una passthrough al componente.
 * Il vecchio KodaIntro resta live sulla home finché il nuovo non è pronto.
 */
import React from "react";
import KodaIntroConversational from "../components/KodaIntroConversational";

export default function IntroV2Screen() {
  return <KodaIntroConversational />;
}
