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
    return result as KodaAudioMode;
  } catch (e: any) {
    console.log(
      `[KODA_AUDIO_OUT] setKodaAudioOutput(${output}) error: ${e?.message || e}`
    );
    return "unsupported";
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
    return result as KodaAudioMode;
  } catch {
    return "unsupported";
  }
}
