/**
 * Diagnostic Logger — in-app capture of KODA_* console logs.
 *
 * RAZIONALE (sprint giugno 2026 v12):
 * Su TestFlight / production build, i `console.log` JS finiscono in
 * `os_log` di iOS e sono visibili SOLO collegando l'iPhone a un Mac con
 * Console.app o Xcode. L'utente che testa con solo iPhone non ha modo
 * di estrarre i log → siamo costretti a debuggare alla cieca.
 *
 * SOLUZIONE: intercettiamo TUTTI i `console.log` e teniamo gli ultimi
 * MAX_EVENTS che iniziano con `[KODA_` in un ring buffer in memoria.
 * Una schermata `/diagnostics` li mostra e permette copia/condivisione.
 *
 * PERFORMANCE: l'intercettore è pass-through (chiama l'originale subito
 * dopo), filtra per prefisso (fast), e il push su array è O(1) ammortizzato.
 * Niente JSON.stringify, niente regex pesanti. Zero impatto runtime.
 */

const MAX_EVENTS = 500;
// === FILTRO DIAGNOSTICO (Fabio 2026-06-23 — fix prefisso VAD_TRACE) ===
// Cattura qualsiasi log che inizi con uno dei prefissi noti. Robusto
// anche se in passato è stato emesso con prefisso vecchio (es. [VAD_TRACE]
// senza "KODA_" davanti — bug del 2026-06-23 in voice.ts).
const CAPTURE_PREFIXES = [
  "[KODA_",        // Tutti gli eventi nuovi del sistema diagnostico Koda
  "[VAD_",         // Legacy: [VAD_TRACE], [VAD_CALIB] emessi prima del rename
  "[AUDIO_HONESTY", // Honesty Phase 1
];
function _matchesCapture(s: string): boolean {
  for (const p of CAPTURE_PREFIXES) {
    if (s.startsWith(p)) return true;
  }
  return false;
}

export type DiagEvent = {
  t: number;          // Date.now() di quando è stato emesso
  line: string;       // Riga completa, come da console.log
};

let buffer: DiagEvent[] = [];
let installed = false;
let originalLog: typeof console.log | null = null;
let originalWarn: typeof console.warn | null = null;
let originalError: typeof console.error | null = null;

/**
 * Wrap che cattura un metodo di console (log/warn/error) nel buffer
 * diagnostico. Fix 2026-06-25: prima si intercettava SOLO console.log,
 * quindi `console.warn("[KODA_X] error: ...")` veniva eseguito ma NON
 * salvato nel ring buffer → "silenzio" ingannevole nei log esportati
 * (gli errori avvenivano, semplicemente non li vedevamo).
 */
function _captureWith(
  original: (...args: any[]) => void,
  tag: string
): (...args: any[]) => void {
  return (...args: any[]) => {
    try {
      const first = args[0];
      if (typeof first === "string" && _matchesCapture(first)) {
        const line = args.map((a) => {
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(" ");
        // Prefisso del livello (W/E) per distinguere warn/error nel buffer
        const tagged = tag ? `[${tag}] ${line}` : line;
        buffer.push({ t: Date.now(), line: tagged });
        if (buffer.length > MAX_EVENTS) buffer.shift();
      }
    } catch {}
    try { original(...args); } catch {}
  };
}

/**
 * Installa l'intercettore su console.log/warn/error (idempotente).
 * Va chiamato UNA VOLTA all'avvio dell'app.
 */
export function installDiagLogger(): void {
  if (installed) return;
  installed = true;
  originalLog = console.log.bind(console);
  originalWarn = console.warn.bind(console);
  originalError = console.error.bind(console);
  console.log = _captureWith(originalLog, "");      // log = niente tag (default)
  console.warn = _captureWith(originalWarn, "W");   // warn = [W] prefix
  console.error = _captureWith(originalError, "E"); // error = [E] prefix
}

/** Ritorna una COPIA del buffer attuale (l'ordine è cronologico FIFO). */
export function getDiagEvents(): DiagEvent[] {
  return buffer.slice();
}

/** Svuota il buffer. Usato dal pulsante "Clear" nella schermata diag. */
export function clearDiagEvents(): void {
  buffer = [];
}

/**
 * Genera una stringa pronta da incollare in chat / email / Slack.
 * Formato: timestamp ISO relativo a "ora" + riga del log.
 *
 * Esempio output:
 *   -02:14.103 [KODA_VAD] heartbeat t=500ms ...
 *   -02:13.532 [KODA_VAD] speech_start db=-28 ...
 *   -02:13.103 [KODA_TIMING] VOICE_END 1234ms ...
 */
export function formatDiagEventsForExport(events?: DiagEvent[]): string {
  const evs = events ?? buffer;
  if (evs.length === 0) return "(nessun evento KODA_* catturato)";
  const now = Date.now();
  const lines: string[] = [];
  lines.push(`=== Koda diag log — ${new Date(now).toISOString()} ===`);
  lines.push(`Eventi catturati: ${evs.length} (max ${MAX_EVENTS})`);
  lines.push("");
  for (const ev of evs) {
    const deltaMs = now - ev.t;
    // Formato relativo: "-MM:SS.mmm" così è leggibile a colpo d'occhio.
    const totSec = Math.floor(deltaMs / 1000);
    const mm = String(Math.floor(totSec / 60)).padStart(2, "0");
    const ss = String(totSec % 60).padStart(2, "0");
    const ms = String(deltaMs % 1000).padStart(3, "0");
    lines.push(`-${mm}:${ss}.${ms}  ${ev.line}`);
  }
  return lines.join("\n");
}
