/**
 * KodaAudioOutput — STUB NO-OP.
 *
 * === ROLLBACK 2026-07-13 ===
 * La feature "Modalità Telefono" (toggle earpiece/speaker) è stata
 * completamente rimossa dopo che il custom AVAudioSession routing ha
 * causato regressioni gravi nel core STT loop (recording infinito,
 * chunk STT vuoti). Vedi /app/summary/refund_documentation.md.
 *
 * Questo file resta come stub per NON rompere eventuali import
 * legacy — tutti gli export ritornano "unsupported" / null / no-op.
 * Sarà rimosso in una futura pulizia quando nessun import lo referenzia.
 */

export type KodaAudioMode =
  | "earpiece"
  | "speaker"
  | "auto"
  | "unsupported"
  | `external:${string}`
  | `auto:${string}`;

export function getCachedKodaOverride(): "earpiece" | "speaker" | null {
  return null;
}

export async function setKodaAudioOutput(
  _output: "earpiece" | "speaker" | "auto"
): Promise<KodaAudioMode> {
  return "unsupported";
}

export async function reapplyKodaAudioOverride(): Promise<void> {
  return;
}

export async function getKodaAudioOutput(): Promise<KodaAudioMode> {
  return "unsupported";
}
