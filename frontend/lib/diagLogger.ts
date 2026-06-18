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
const KODA_PREFIX = "[KODA_";

export type DiagEvent = {
  t: number;          // Date.now() di quando è stato emesso
  line: string;       // Riga completa, come da console.log
};

let buffer: DiagEvent[] = [];
let installed = false;
let originalLog: typeof console.log | null = null;

/**
 * Installa l'intercettore su `console.log` (idempotente). Va chiamato
 * UNA VOLTA all'avvio dell'app, prima di qualsiasi altro modulo che
 * emetta log KODA_*.
 */
export function installDiagLogger(): void {
  if (installed) return;
  installed = true;
  originalLog = console.log.bind(console);
  console.log = (...args: any[]) => {
    try {
      // Solo se il PRIMO argomento è una stringa che comincia con [KODA_
      // catturiamo. Altrimenti pass-through silenzioso.
      const first = args[0];
      if (typeof first === "string" && first.startsWith(KODA_PREFIX)) {
        // Compone la riga concatenando args (semplice toString).
        const line = args.map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }).join(" ");
        buffer.push({ t: Date.now(), line });
        if (buffer.length > MAX_EVENTS) {
          // Drop oldest: shift mantiene FIFO. Eseguito raramente (solo
          // quando il buffer è pieno) → costo trascurabile.
          buffer.shift();
        }
      }
    } catch {
      // Nessuna eccezione deve impedire il log originale di partire.
    }
    if (originalLog) {
      try { originalLog(...args); } catch {}
    }
  };
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
