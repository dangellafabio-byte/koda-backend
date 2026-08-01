/**
 * perfDiag.ts — Utility di profiling performance per Koda.
 *
 * Attivazione: EXPO_PUBLIC_KODA_PERF_DIAG=1 nel .env
 * (o via build flag). Se disattivato, tutti gli hook sono no-op → zero
 * overhead in produzione.
 *
 * Metriche esposte:
 *   [KODA_PERF_FPS]              framerate reale ogni 2s
 *   [KODA_PERF_ROOT]             render count e tempi del root MainRoot
 *   [KODA_PERF_TIMELINE_BUBBLE]  render count delle Bubble (timeline chat)
 *   [KODA_PERF_TIMELINE_LIST]    render count della FlashList
 *   [KODA_PERF_SETTINGS]         render count del SettingsModal
 *   [KODA_PERF_ANIM_ECLIPSE]     stato animazioni EclipseOrb
 *
 * DISCLAIMER: v64.14 (2026-07-31, Fabio). Uso diagnostico temporaneo per
 * isolare la lentezza scroll su Android Xiaomi. Da rimuovere dopo aver
 * identificato il collo di bottiglia con numeri reali.
 */
import { useEffect, useRef } from "react";

export const PERF_ENABLED =
  (process.env.EXPO_PUBLIC_KODA_PERF_DIAG ?? "0") === "1";

// === RENDER COUNTERS =======================================================
// Ogni componente ha un contatore aggregato; ogni 5 secondi il totale
// viene flushato su console con avg-timing e reset.
type CounterState = {
  count: number;
  totalMs: number;
  lastLogAt: number;
};
const counters = new Map<string, CounterState>();
const FLUSH_INTERVAL_MS = 5000;

function getOrInit(key: string): CounterState {
  let s = counters.get(key);
  if (!s) {
    s = { count: 0, totalMs: 0, lastLogAt: Date.now() };
    counters.set(key, s);
  }
  return s;
}

function maybeFlush(key: string): void {
  const s = counters.get(key);
  if (!s) return;
  const now = Date.now();
  const elapsed = now - s.lastLogAt;
  if (elapsed >= FLUSH_INTERVAL_MS && s.count > 0) {
    const avg = s.totalMs / s.count;
    const rate = (s.count / elapsed) * 1000;
    console.log(
      `[${key}] count=${s.count} avg=${avg.toFixed(2)}ms rate=${rate.toFixed(1)}/s over ${(elapsed / 1000).toFixed(1)}s`,
    );
    s.count = 0;
    s.totalMs = 0;
    s.lastLogAt = now;
  }
}

/** Hook per contare render + timing di un componente.
 *  Usa: useRenderCounter("KODA_PERF_TIMELINE_BUBBLE")
 *  L'hook stesso non deve essere costoso — misura solo il render count.
 *  Le regole degli hook React richiedono che gli hook siano chiamati sempre
 *  nello stesso ordine, quindi qui li chiamiamo sempre ma li facciamo no-op
 *  se PERF_ENABLED=false. */
export function useRenderCounter(label: string): void {
  const startRef = useRef<number>(0);
  if (PERF_ENABLED) startRef.current = performance.now();
  useEffect(() => {
    if (!PERF_ENABLED) return;
    const dur = performance.now() - startRef.current;
    const s = getOrInit(label);
    s.count += 1;
    s.totalMs += dur;
    maybeFlush(label);
  });
}

// === FPS COUNTER ============================================================
// Usa requestAnimationFrame per contare i frame in una finestra di 2s
// e loggare il framerate medio. Se scende sotto 55fps c'è jank.
let fpsRafHandle: number | null = null;
let fpsFrames = 0;
let fpsWindowStart = 0;
const FPS_WINDOW_MS = 2000;

function fpsTick() {
  fpsFrames += 1;
  const now = performance.now();
  const elapsed = now - fpsWindowStart;
  if (elapsed >= FPS_WINDOW_MS) {
    const fps = (fpsFrames / elapsed) * 1000;
    const dropped = Math.max(0, Math.round(((60 - fps) / 60) * (fpsFrames)));
    console.log(
      `[KODA_PERF_FPS] fps=${fps.toFixed(1)} frames=${fpsFrames} dropped≈${dropped} window=${(elapsed / 1000).toFixed(1)}s`,
    );
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  fpsRafHandle = requestAnimationFrame(fpsTick);
}

export function startFpsMonitor(): void {
  if (!PERF_ENABLED) return;
  if (fpsRafHandle != null) return;
  fpsWindowStart = performance.now();
  fpsFrames = 0;
  fpsRafHandle = requestAnimationFrame(fpsTick);
  console.log("[KODA_PERF_FPS] monitor started (target 60fps)");
}

export function stopFpsMonitor(): void {
  if (fpsRafHandle != null) {
    cancelAnimationFrame(fpsRafHandle);
    fpsRafHandle = null;
  }
}

// === ANIMATION FLAG ==========================================================
/** Loggato solo quando cambia — utile per capire se EclipseOrb sta
 *  animando durante uno scroll di Impostazioni (dovrebbe stare fermo). */
const animStates = new Map<string, string>();
export function logAnimState(name: string, state: string): void {
  if (!PERF_ENABLED) return;
  const prev = animStates.get(name);
  if (prev === state) return;
  animStates.set(name, state);
  console.log(`[KODA_PERF_ANIM_${name.toUpperCase()}] ${state}`);
}
