/**
 * latencyTracer — Strumento di diagnostica delle latenze end-to-end.
 *
 * Uso:
 *   import { traceStart, traceMark, traceSubscribe } from "./latencyTracer";
 *
 *   traceStart();                          // T0
 *   traceMark("optimistic_shown");         // T0 + Δms
 *   traceMark("safety_done");
 *   traceMark("llm_first_chunk");
 *   ...
 *
 * Il LatencyOverlay si iscrive con traceSubscribe e mostra una lista live
 * dei marker raccolti. Non è invasivo: se nessuno è iscritto, il tracer è
 * comunque attivo (low cost) e i dati restano in memoria fino al prossimo
 * traceStart/traceReset.
 */

export type Mark = { label: string; ms: number; abs: number };

let t0: number | null = null;
const marks: Mark[] = [];
const listeners = new Set<(m: Mark[]) => void>();

export function traceStart(): void {
  t0 = Date.now();
  marks.length = 0;
  emit();
}

export function traceMark(label: string): void {
  if (t0 === null) {
    // Inizia automaticamente se chiamato senza un esplicito start
    t0 = Date.now();
  }
  const now = Date.now();
  marks.push({ label, ms: now - t0, abs: now });
  emit();
}

export function traceReset(): void {
  t0 = null;
  marks.length = 0;
  emit();
}

export function traceGetMarks(): Mark[] {
  return marks.slice();
}

export function traceSubscribe(cb: (m: Mark[]) => void): () => void {
  listeners.add(cb);
  // Subito uno snapshot iniziale
  try { cb(marks.slice()); } catch {}
  return () => {
    listeners.delete(cb);
  };
}

function emit(): void {
  const snap = marks.slice();
  for (const cb of listeners) {
    try { cb(snap); } catch {}
  }
}
