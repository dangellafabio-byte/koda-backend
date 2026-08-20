/**
 * /microdemo — Route della fase D del piano V3 (Fabio 2026-08-22).
 * Micro-demo vocale Koda: max 3 turni / 90s / 1x per 24h per device.
 * File-based routing Expo, wrapper passthrough al componente.
 */
import React from "react";
import MicroDemoKoda from "../components/MicroDemoKoda";

export default function MicroDemoScreen() {
  return <MicroDemoKoda />;
}
