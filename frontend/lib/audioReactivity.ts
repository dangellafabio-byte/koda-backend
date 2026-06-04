/**
 * audioReactivity.ts — bridge tra TTS playback e l'orb
 *
 * Architettura "orb reattivo" (richiesta utente 2026-06 #3):
 *   1) Backend estrae l'envelope RMS dall'mp3 di Koda (~16 valori/sec).
 *   2) Lo invia al frontend insieme al token audio della frase.
 *   3) Quando il player audio inizia a riprodurre quella frase, registriamo
 *      qui il waveform + tempo di inizio.
 *   4) L'orb (in components/Orb.tsx) si sottoscrive e ogni frame legge il
 *      valore corrente del waveform interpolato dalla posizione del
 *      currentTime nell'audio → pulsa in sincrono con sillabe e accenti
 *      reali della voce di Koda.
 *
 * Soluzione singleton (modulo-level state + listeners) per evitare prop
 * drilling e mantenere il componente Orb agnostico al ciclo TTS.
 */

type Listener = (value: number) => void;

let currentWaveform: number[] | null = null;
let currentWindowMs = 60;
let currentStartTs = 0;
let currentDurationMs = 0;
let listeners: Set<Listener> = new Set();
let rafHandle: number | null = null;

/**
 * Inizia il driving dell'orb usando l'envelope passato.
 * @param waveform array di RMS normalizzati 0..1
 * @param windowMs durata di ogni sample (es. 60ms = ~16Hz)
 */
export function startReactiveWaveform(waveform: number[] | null | undefined, windowMs: number = 60) {
  if (!waveform || waveform.length === 0) {
    stopReactiveWaveform();
    return;
  }
  currentWaveform = waveform;
  currentWindowMs = Math.max(15, Math.min(300, windowMs));
  currentStartTs = Date.now();
  currentDurationMs = waveform.length * currentWindowMs;
  _ensureLoop();
}

/**
 * Ferma il driving e azzera tutti i listener (li resetta a 0).
 */
export function stopReactiveWaveform() {
  currentWaveform = null;
  currentStartTs = 0;
  currentDurationMs = 0;
  // Notifica subito gli ascoltatori per far tornare l'orb a 0 morbidamente.
  for (const l of listeners) {
    try { l(0); } catch {}
  }
  if (rafHandle != null) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafHandle);
    else clearTimeout(rafHandle as unknown as number);
    rafHandle = null;
  }
}

/**
 * Sottoscrive un listener. Ritorna funzione di unsubscribe.
 * Il listener viene chiamato ad ogni frame con un valore 0..1.
 */
export function subscribeReactive(fn: Listener): () => void {
  listeners.add(fn);
  _ensureLoop();
  return () => {
    listeners.delete(fn);
  };
}

function _ensureLoop() {
  if (rafHandle != null) return;
  const tick = () => {
    if (listeners.size === 0) {
      rafHandle = null;
      return;
    }
    let v = 0;
    if (currentWaveform && currentWaveform.length > 0) {
      const elapsed = Date.now() - currentStartTs;
      if (elapsed >= 0 && elapsed <= currentDurationMs + 200) {
        // Indice frazionario nel waveform (interpolazione lineare).
        const idxF = elapsed / currentWindowMs;
        const i0 = Math.max(0, Math.min(currentWaveform.length - 1, Math.floor(idxF)));
        const i1 = Math.max(0, Math.min(currentWaveform.length - 1, i0 + 1));
        const t = idxF - i0;
        const raw = currentWaveform[i0] * (1 - t) + currentWaveform[i1] * t;
        // Espansione percettiva: i valori RMS in voce parlata stanno
        // tipicamente nel 0.1-0.5; mappiamo verso 0.2-0.95 per dare
        // più movimento visibile all'orb.
        v = Math.max(0, Math.min(1, (raw - 0.05) * 2.2));
      }
    }
    for (const l of listeners) {
      try { l(v); } catch {}
    }
    if (typeof requestAnimationFrame === "function") {
      rafHandle = requestAnimationFrame(tick) as unknown as number;
    } else {
      rafHandle = setTimeout(tick, 16) as unknown as number;
    }
  };
  if (typeof requestAnimationFrame === "function") {
    rafHandle = requestAnimationFrame(tick) as unknown as number;
  } else {
    rafHandle = setTimeout(tick, 16) as unknown as number;
  }
}
