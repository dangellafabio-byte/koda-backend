/**
 * useOrbAmbient — Calcola gli "umori" di Coda derivandoli puramente da:
 *  - la timeline (numero e freschezza delle interazioni)
 *  - l'ora del giorno
 *
 * Niente AsyncStorage, niente persistenza extra: lo stato è già tutto nel DB
 * del profilo / timeline. Questo hook è un *derived value*.
 *
 * Output:
 *  - warmth (0..1): quanto Coda "brilla" → cresce con interazioni recenti,
 *    decade lentamente (mezza vita ~3h). Più parli con Coda, più è viva.
 *  - dim (0..1): quanto è *spenta* per inattività → 0 se hai parlato di
 *    recente, sale verso 0.7 dopo 6+ ore di silenzio.
 *  - palette (3 colori): tono ora-del-giorno (alba calda, giorno neutro,
 *    tramonto ambra, sera blu, notte viola profondo).
 *  - timeOfDay: nome leggibile della fascia oraria (per debug/UX).
 */
import { useEffect, useMemo, useState } from "react";
import type { TimelineEntry } from "./api";

export type AmbientPalette = [string, string, string]; // [outer, mid, core]

export type OrbAmbient = {
  warmth: number;
  dim: number;
  palette: AmbientPalette;
  timeOfDay: "alba" | "mattino" | "giorno" | "tramonto" | "sera" | "notte";
};

// === Time-of-day palettes (derived once per hour change)
//     Each palette is calibrated to feel emotionally right for that moment:
//     alba = calda risveglio, giorno = neutra/serena, tramonto = ambra/rosa,
//     sera = blu introspettivo, notte = viola intima.
const PALETTES: Record<OrbAmbient["timeOfDay"], AmbientPalette> = {
  alba: ["#FCD34D", "#FB923C", "#F472B6"],       // ambra → pesca → rosa
  mattino: ["#FDE68A", "#FBBF24", "#F59E0B"],     // giallo caldo
  giorno: ["#A78BFA", "#8B5CF6", "#7C3AED"],      // viola sereno (default)
  tramonto: ["#FBBF24", "#F97316", "#EC4899"],    // ambra → arancio → fucsia
  sera: ["#60A5FA", "#6366F1", "#8B5CF6"],        // blu → indaco → viola
  notte: ["#7C3AED", "#5B21B6", "#1E1B4B"],       // viola profondo
};

function timeOfDayFor(date: Date): OrbAmbient["timeOfDay"] {
  const h = date.getHours();
  if (h >= 5 && h < 7) return "alba";
  if (h >= 7 && h < 11) return "mattino";
  if (h >= 11 && h < 17) return "giorno";
  if (h >= 17 && h < 20) return "tramonto";
  if (h >= 20 && h < 23) return "sera";
  return "notte";
}

/**
 * Compute warmth from timeline:
 *  - Count user+AI messages in the last 6 hours
 *  - Apply exponential decay so very recent messages count more
 *  - Saturate at ~15 messages to reach max warmth (1.0)
 */
function computeWarmth(timeline: TimelineEntry[], now: number): number {
  if (!timeline.length) return 0;
  const HALF_LIFE_MS = 3 * 60 * 60 * 1000; // 3h half-life
  let acc = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const t = Date.parse(timeline[i].timestamp);
    if (isNaN(t)) continue;
    const ageMs = now - t;
    if (ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) {
      // Stop scanning once we go beyond 24h — older messages don't influence
      if (ageMs > 24 * 60 * 60 * 1000) break;
      continue;
    }
    // Each message adds (1/2)^(age / half_life) to the accumulator
    acc += Math.pow(0.5, ageMs / HALF_LIFE_MS);
  }
  // Saturate at 12 weighted messages → 1.0 warmth
  return Math.max(0, Math.min(1, acc / 12));
}

/**
 * Compute dim from last interaction freshness:
 *  - 0 (fully present) if interacted within last hour
 *  - rises towards 0.7 (very faded) after 6+ hours
 *  - eternally maxed at 0.85 if no timeline at all (first launch — Coda is
 *    quietly waiting, not absent)
 */
function computeDim(timeline: TimelineEntry[], now: number): number {
  if (!timeline.length) return 0.5;
  let lastTs = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const t = Date.parse(timeline[i].timestamp);
    if (!isNaN(t) && t > lastTs) lastTs = t;
  }
  if (lastTs === 0) return 0.5;
  const ageH = (now - lastTs) / (60 * 60 * 1000);
  if (ageH < 1) return 0;
  if (ageH < 3) return 0.2;
  if (ageH < 6) return 0.4;
  if (ageH < 12) return 0.55;
  return 0.7;
}

export function useOrbAmbient(timeline: TimelineEntry[]): OrbAmbient {
  // Re-tick every minute so palette + warmth + dim stay accurate without
  // re-rendering on every keystroke.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const now = Date.now();
    const tod = timeOfDayFor(new Date(now));
    return {
      warmth: computeWarmth(timeline, now),
      dim: computeDim(timeline, now),
      palette: PALETTES[tod],
      timeOfDay: tod,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, tick]);
}
