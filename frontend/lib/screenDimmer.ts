/**
 * screenDimmer.ts — Auto-dim schermo durante hands-free (Fabio 2026-07-28)
 *
 * OBIETTIVO
 *   Ridurre il consumo batteria/calore su iPhone durante conversazione
 *   hands-free, quando l'utente non tocca lo schermo per un po' (sta
 *   solo parlando/ascoltando). Lo schermo acceso al 100% è uno dei
 *   consumi principali; dimmerarlo al 50% ha un impatto significativo.
 *
 * SPEC (versione semplificata concordata con Fabio 2026-07-28)
 *   - Dopo 35s di inattività touch DURANTE conversazione hands-free
 *     (stati: recording, thinking, speaking) → fade graduale della
 *     luminosità al 50% del valore attuale utente (2 sec, ease-out).
 *   - Un solo livello di dim: **50% e basta**, mai più scuro anche
 *     dopo tempi lunghi.
 *   - Al PRIMO touch dello schermo O all'uscita dallo stato attivo
 *     → restore rapido al 100% originale (300ms, ease-in).
 *   - Su AppState background/inactive → restore automatico (iOS resetta
 *     comunque da solo, ma noi ripuliamo per coerenza).
 *   - Su AppState foreground → se conversazione ancora attiva riparte
 *     il timer da zero (l'utente potrebbe aver interagito con altro).
 *
 * VINCOLI TECNICI
 *   - `expo-brightness.setBrightnessAsync(v)` imposta APP-LEVEL brightness
 *     (non tocca la setting di sistema, torna al valore utente all'uscita).
 *   - Nessun permesso richiesto su iOS. Nessun permesso app-level su Android.
 *   - iOS resetta la brightness quando l'app va in background — gestito
 *     via AppState listener.
 *
 * ANIMAZIONE FADE
 *   Non uso `Animated` di React Native perché setBrightnessAsync è un
 *   metodo nativo async, non un valore CSS/RN. Uso un setInterval a ~30fps
 *   che chiama setBrightnessAsync progressivamente. Non è "vero" 60fps ma
 *   è sufficiente per una transizione percepita fluida (2000ms).
 */

import * as Brightness from "expo-brightness";
import { Platform } from "react-native";

// ============================================================================
// Debug logging (Fabio 2026-07-29 — fix "dim non funziona")
// ============================================================================
// I log restano ATTIVI in produzione perché il dim si testa solo su
// dispositivo reale hands-free (loop di 35s → non riproducibile in web).
// Il costo è trascurabile (~1 log ogni 35s + touch events).
const DBG = true;
function log(...args: any[]) {
  if (DBG) console.log("[KODA_DIMMER]", ...args);
}

// ============================================================================
// Config (concordata con Fabio 2026-07-28)
// ============================================================================
/** Delay in ms prima di iniziare a dimmerare dopo l'ultima interazione. */
const IDLE_BEFORE_DIM_MS = 35_000;
/** Livello di dimmer: fattore moltiplicativo del brightness originale. */
const DIM_FACTOR = 0.5;
/** Durata del fade DOWN (verso il 50%). */
const FADE_DOWN_MS = 2_000;
/** Durata del fade UP (restore al 100%). */
const FADE_UP_MS = 300;
/** Frequenza aggiornamenti brightness durante il fade (30fps ≈ 33ms). */
const FADE_TICK_MS = 33;

// ============================================================================
// Runtime state (singleton)
// ============================================================================
type DimmerState = "off" | "watching" | "dimming" | "dimmed" | "restoring";

let state: DimmerState = "off";
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;

/** Il brightness "originale" al momento in cui abbiamo iniziato a osservare.
 *  Al restore torniamo a QUESTO valore (rispettando la scelta dell'utente). */
let originalBrightness: number | null = null;

/** Ultima brightness applicata da noi (per calcoli di fade). */
let currentAppliedBrightness: number | null = null;

// ============================================================================
// Utility
// ============================================================================
function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function clearFadeTimer() {
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

/**
 * Cattura la brightness attuale come "originale" (una sola volta per sessione
 * di watching). Se abbiamo già un valore salvato, lo teniamo — non vogliamo
 * sovrascrivere con un valore già dimmerato da noi.
 */
async function captureOriginalIfNeeded(): Promise<void> {
  if (originalBrightness !== null) return;
  try {
    const cur = await Brightness.getBrightnessAsync();
    originalBrightness = cur;
    currentAppliedBrightness = cur;
    log("captureOriginal ok — brightness=", cur.toFixed(3));
  } catch (e) {
    // Se non riusciamo a leggere, assumiamo 1.0 come safety (nessun dim)
    originalBrightness = 1.0;
    currentAppliedBrightness = 1.0;
    log("captureOriginal FAIL (fallback 1.0) — err=", String(e));
  }
}

/**
 * Anima la brightness da `from` a `to` in `durationMs` con easing lineare
 * (sufficiente per transizioni brevi). Al termine `onComplete` (opzionale).
 * Interrompibile: se chiamato di nuovo mentre in corso, il vecchio fade
 * si ferma e parte quello nuovo dallo stato corrente.
 */
function animateBrightness(
  from: number,
  to: number,
  durationMs: number,
  onComplete?: () => void
) {
  clearFadeTimer();
  const steps = Math.max(1, Math.round(durationMs / FADE_TICK_MS));
  let step = 0;
  log(`animate: ${from.toFixed(3)} → ${to.toFixed(3)} in ${durationMs}ms (${steps} steps)`);
  fadeTimer = setInterval(async () => {
    step += 1;
    const t = Math.min(1, step / steps);
    // Easing lineare — sufficiente per pochi secondi
    const v = from + (to - from) * t;
    const clamped = Math.max(0.01, Math.min(1.0, v));
    currentAppliedBrightness = clamped;
    try {
      await Brightness.setBrightnessAsync(clamped);
    } catch (e) {
      // Log e interrompi: senza brightness non ha senso continuare
      log("setBrightnessAsync FAIL — err=", String(e));
      clearFadeTimer();
      return;
    }
    if (step >= steps) {
      log(`animate DONE at ${clamped.toFixed(3)}`);
      clearFadeTimer();
      if (onComplete) onComplete();
    }
  }, FADE_TICK_MS);
}

// ============================================================================
// API pubblica
// ============================================================================

/**
 * Inizia a monitorare per il dimmer. Chiamato quando entriamo in stato
 * attivo (recording/thinking/speaking). Cattura brightness originale e
 * fa partire l'idle timer.
 *
 * IDEMPOTENZA CRITICA (fix Fabio 2026-07-29):
 *   Se già in watching o oltre, NON facciamo nulla — NON resettiamo il
 *   timer. Prima resettavamo, ma durante hands-free lo `status` cicla
 *   rapidamente (recording→thinking→speaking→recording…) e ogni cambio
 *   chiamava startWatching → resetIdleTimer → il timer di 35s non
 *   arrivava MAI a scadere → dim non partiva mai.
 *   Ora il timer viene resettato SOLO da noteInteraction() (touch reale
 *   utente), come da spec "timer basato su tocco utente".
 */
export async function startWatching(): Promise<void> {
  // Web: expo-brightness non è supportato. No-op silenzioso.
  if (Platform.OS === "web") return;
  if (state !== "off") {
    // Già watching: NO-OP totale. Il cambio di stato di Koda (recording
    // → thinking → speaking) NON deve resettare il timer di inattività.
    return;
  }
  await captureOriginalIfNeeded();
  state = "watching";
  log("startWatching → armed idle timer (35s)");
  resetIdleTimer();
}

/**
 * Ferma il monitoraggio E ripristina la brightness originale (fade rapido).
 * Chiamato quando esce dallo stato attivo (torna idle) o quando l'app va
 * in background.
 */
export async function stopWatching(): Promise<void> {
  if (Platform.OS === "web") return;
  clearIdleTimer();
  if (state === "off") return;
  const wasDimmed = state === "dimming" || state === "dimmed" || state === "restoring";
  const from = currentAppliedBrightness ?? originalBrightness ?? 1.0;
  const to = originalBrightness ?? 1.0;
  log(`stopWatching (wasDimmed=${wasDimmed}, from=${from.toFixed(3)}, to=${to.toFixed(3)})`);
  state = "off";
  if (wasDimmed && Math.abs(from - to) > 0.01) {
    // Restore graduale a original (rapido, 300ms)
    animateBrightness(from, to, FADE_UP_MS, () => {
      // Reset stato per prossima sessione
      originalBrightness = null;
      currentAppliedBrightness = null;
    });
  } else {
    // Non eravamo dimmerati, reset immediato
    originalBrightness = null;
    currentAppliedBrightness = null;
    clearFadeTimer();
  }
}

/**
 * Segnala un'interazione utente (touch, gesture). Ha due effetti:
 *   1. Se siamo dimmerati (o in fade DOWN): fa un fade UP veloce al 100%
 *   2. Reset dell'idle timer → l'utente ha 35s da adesso prima del prossimo dim
 * Chiamato da onTouchStart/onStartShouldSetResponder del layer root nell'app.
 * Sicuro da chiamare in high-frequency: l'idle timer viene semplicemente
 * resettato, e il fade UP parte solo se necessario.
 */
export function noteInteraction(): void {
  if (Platform.OS === "web") return;
  if (state === "off") return;

  // Se siamo dimmerati o stavamo per farlo, restore
  if (state === "dimming" || state === "dimmed" || state === "restoring") {
    const from = currentAppliedBrightness ?? originalBrightness ?? 1.0;
    const to = originalBrightness ?? 1.0;
    log(`noteInteraction → restore from ${from.toFixed(3)} to ${to.toFixed(3)}`);
    if (Math.abs(from - to) > 0.01) {
      state = "restoring";
      animateBrightness(from, to, FADE_UP_MS, () => {
        state = "watching";
      });
    } else {
      state = "watching";
    }
  }

  // Sempre: reset del timer di idle
  resetIdleTimer();
}

/**
 * Riavvia il timer di inattività. Interno, ma esportato per casi in cui
 * il consumer sa che c'è stato qualcosa di equivalente a un touch (es.
 * rotazione device, wake da lock screen).
 */
export function resetIdleTimer(): void {
  if (state === "off") return;
  clearIdleTimer();
  log(`resetIdleTimer — timer armato per ${IDLE_BEFORE_DIM_MS}ms (state=${state})`);
  // Aspetta IDLE_BEFORE_DIM_MS senza altre interazioni → dim
  idleTimer = setTimeout(() => {
    log("idle timer scaduto → triggerDim()");
    triggerDim();
  }, IDLE_BEFORE_DIM_MS);
}

/**
 * Trigger interno: dopo IDLE_BEFORE_DIM_MS senza interazioni, avvia il
 * fade DOWN al 50% del valore originale.
 */
async function triggerDim(): Promise<void> {
  if (state !== "watching") {
    log(`triggerDim skipped — state=${state}`);
    return;
  }
  const from = currentAppliedBrightness ?? originalBrightness ?? 1.0;
  const target = (originalBrightness ?? 1.0) * DIM_FACTOR;
  log(`triggerDim FIRED — from=${from.toFixed(3)} target=${target.toFixed(3)}`);
  if (from <= target + 0.01) {
    // Già sotto il target (l'utente ha già impostato manualmente basso) → skip
    log("triggerDim skipped — already below target");
    state = "dimmed";
    return;
  }
  state = "dimming";
  animateBrightness(from, target, FADE_DOWN_MS, () => {
    state = "dimmed";
    log("triggerDim complete — state=dimmed");
  });
}

/**
 * Debug/introspection: stato corrente. Utile in log diagnostici.
 */
export function getDebugState(): { state: DimmerState; original: number | null; current: number | null } {
  return {
    state,
    original: originalBrightness,
    current: currentAppliedBrightness,
  };
}
