/**
 * KodaAudioOutput — wrapper JS per la Modalità Telefono manuale.
 *
 * Chiama la AsyncFunction Swift `kodaSetAudioOutput` (iniettata via config plugin
 * withExpoAudioVoiceProcessing v17) per forzare il routing audio iOS su:
 *   • "earpiece" — auricolare interno (come telefonata)
 *   • "speaker"  — altoparlante esterno
 *   • "auto"     — ripristina il proximity observer automatico
 *
 * Comportamento cross-device:
 *   • Se AirPods/BT/CarPlay/cuffie sono collegate → l'audio ci va e la
 *     funzione ritorna "external:<PortName>" senza forzare nulla.
 *   • Su Android: no-op (Android non ha AVAudioSession) — ritorna "unsupported".
 *
 * Storage: la modalità manuale è persistita in iOS UserDefaults (survive kill).
 * `resetToAuto()` la cancella.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

export type KodaAudioMode =
  | "earpiece"
  | "speaker"
  | "auto"
  | "unsupported"
  | `external:${string}`
  | `auto:${string}`;

let _module: any = null;
function getModule(): any {
  if (_module) return _module;
  try {
    _module = requireOptionalNativeModule("ExpoAudio");
  } catch {
    _module = null;
  }
  return _module;
}

// === KODA v18 JS CACHE ===
// Cache in-process della modalità manuale corrente. Serve al TTS play loop
// (lib/speech.ts) per ri-applicare l'override DOPO ogni setAudioModeAsync,
// perché expo-audio setAudioModeAsync distrugge silenziosamente
// l'overrideOutputAudioPort iOS (resetta la sessione a .playback).
//
// Aggiornato ad ogni setKodaAudioOutput(). Vale solo per la sessione
// corrente in RAM — al kill dell'app viene ripreso da UserDefaults lato
// Swift, ma il primo mount JS deve chiamare getKodaAudioOutput() per
// sincronizzare la cache.
let _cachedOverride: "earpiece" | "speaker" | null = null;

export function getCachedKodaOverride(): "earpiece" | "speaker" | null {
  return _cachedOverride;
}

/**
 * Forza l'output audio su earpiece o speaker, oppure ripristina l'auto (proximity).
 * Ritorna la modalità applicata effettiva (utile se BT/AirPods hanno la precedenza).
 */
export async function setKodaAudioOutput(
  output: "earpiece" | "speaker" | "auto"
): Promise<KodaAudioMode> {
  if (Platform.OS !== "ios") return "unsupported";
  const m = getModule();
  if (!m || typeof m.kodaSetAudioOutput !== "function") {
    // Binario senza patch v17 → funzione non presente. Fallback silente.
    console.log(
      `[KODA_AUDIO_OUT] Native module missing kodaSetAudioOutput → binary pre-v17. ` +
        `output=${output} ignored.`
    );
    return "unsupported";
  }
  try {
    const result: string = await m.kodaSetAudioOutput(output);
    console.log(
      `[KODA_AUDIO_OUT] setKodaAudioOutput(${output}) → ${result}`
    );
    // === v18 JS CACHE UPDATE ===
    // Aggiorna la cache in RAM cosi il TTS play loop può ri-applicare
    // l'override dopo setAudioModeAsync.
    if (output === "earpiece" || output === "speaker") {
      _cachedOverride = output;
    } else {
      // "auto" o qualsiasi altro → rimuovi override cached
      _cachedOverride = null;
    }
    return result as KodaAudioMode;
  } catch (e: any) {
    console.log(
      `[KODA_AUDIO_OUT] setKodaAudioOutput(${output}) error: ${e?.message || e}`
    );
    return "unsupported";
  }
}

/**
 * v18: Ri-applica silenziosamente l'override manuale corrente (se attivo)
 * dopo un cambio di audio session iOS (es. setAudioModeAsync).
 *
 * Chiamata dopo ogni ciclo `setAudioMode(playback)` in speech.ts. Se
 * l'utente ha attivato "earpiece" via pulsante manuale, questa funzione
 * ri-forza il routing all'auricolare che iOS ha appena resettato.
 *
 * No-op se nessun override attivo (modalità "auto").
 */
export async function reapplyKodaAudioOverride(): Promise<void> {
  if (Platform.OS !== "ios") return;
  if (_cachedOverride == null) return; // auto → nulla da ri-applicare
  const m = getModule();
  if (!m || typeof m.kodaSetAudioOutput !== "function") return;
  try {
    const result: string = await m.kodaSetAudioOutput(_cachedOverride);
    console.log(
      `[KODA_AUDIO_OUT] reapply(${_cachedOverride}) → ${result}`
    );
  } catch (e: any) {
    console.log(
      `[KODA_AUDIO_OUT] reapply(${_cachedOverride}) error: ${e?.message || e}`
    );
  }
}

/**
 * Legge lo stato corrente dell'output audio.
 * Utile per aggiornare l'icona del pulsante UI al mount o dopo cambio di route
 * (es. utente collega/scollega AirPods).
 */
export async function getKodaAudioOutput(): Promise<KodaAudioMode> {
  if (Platform.OS !== "ios") return "unsupported";
  const m = getModule();
  if (!m || typeof m.kodaGetAudioOutput !== "function") {
    return "unsupported";
  }
  try {
    const result: string = await m.kodaGetAudioOutput();
    // v18: sincronizza cache in-process con lo stato nativo (UserDefaults iOS)
    if (result === "earpiece" || result === "speaker") {
      _cachedOverride = result;
    } else {
      _cachedOverride = null;
    }
    return result as KodaAudioMode;
  } catch {
    return "unsupported";
  }
}
