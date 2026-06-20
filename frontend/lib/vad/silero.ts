/**
 * Silero Neural VAD — KILL-SWITCH BULLETPROOF
 * ──────────────────────────────────────────────────────────────────────
 * P1 Fase 1/2 — DISATTIVATO (Fabio escalation 2026-06-20 v7).
 *
 * ⚠️ ATTENZIONE ⚠️
 * `onnxruntime-react-native@1.24.3` è documentato INCOMPATIBILE con
 * `newArchEnabled: true` (Fabric/TurboModules) — issue Microsoft:
 * github.com/microsoft/onnxruntime/issues/17623
 *
 * Il modulo nativo CRASHA via JSI quando si chiama
 * InferenceSession.create() su iOS con NewArch attiva. La nostra app
 * ha `newArchEnabled: true` in app.json e per scelta di design vogliamo
 * tenerla (Reanimated 4, expo-audio nuovi, ecc. la richiedono).
 *
 * Soluzione: NIENTE IMPORT NATIVI in questo file. ZERO chiamate a
 * `onnxruntime-react-native`. Tutte le funzioni esportate ritornano
 * stati "non disponibile" innocui senza toccare alcun modulo JSI.
 *
 * Questo fix viaggia via Expo Updates (OTA) — nessuna nuova TestFlight
 * build necessaria.
 *
 * QUANDO RIPRISTINARE: in una sessione futura migreremo il PoC a
 * `react-native-fast-tflite` (compatibile NewArch) con la versione
 * TFLite ufficiale di Silero VAD. Allora servirà una nuova build.
 */

// === NESSUN IMPORT NATIVO ===
// Volutamente NON importiamo `onnxruntime-react-native` né
// `expo-asset`/`expo-file-system` qui — l'unico effetto sarebbe far
// caricare moduli che non userà mai. Il kill-switch è puro JS.

// === Configurazione runtime (per compatibilità API con la versione viva) ===
export const SAMPLE_RATE = 16_000;
export const CHUNK_SIZE = 512;
export const STATE_DIMS = [2, 1, 128] as const;

export type ModelLoadStatus = {
  ok: boolean;
  modelPath?: string;
  modelSize?: number;
  loadTimeMs?: number;
  sessionInputs?: string[];
  sessionOutputs?: string[];
  error?: string;
};

const KILL_MESSAGE =
  "Silero VAD temporaneamente disattivato.\n\n" +
  "Causa: onnxruntime-react-native (v1.24.3) non è compatibile con " +
  "New Architecture iOS (Fabric/TurboModules) — issue Microsoft #17623. " +
  "Il caricamento del modello crashava l'app via JSI.\n\n" +
  "Verrà ripristinato in una build futura migrando a " +
  "react-native-fast-tflite (compatibile NewArch) con la versione " +
  "TFLite ufficiale di Silero VAD.\n\n" +
  "Nessun impatto sull'app principale: il VAD volumetrico in voice.ts " +
  "continua a funzionare regolarmente.";

/**
 * Kill-switch: nessuna interazione con il modulo nativo.
 * Ritorna immediatamente uno status di errore "gentile".
 */
export async function loadSileroVadModel(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _onProgress?: (received: number, total: number) => void
): Promise<ModelLoadStatus> {
  return {
    ok: false,
    error: KILL_MESSAGE,
  };
}

/**
 * Kill-switch: throw immediato senza toccare il nativo.
 * Mantenuto per compatibilità API con i chiamanti (sileroStream.ts).
 */
export async function runVadInference(_chunk: Float32Array): Promise<number> {
  throw new Error("Silero VAD disattivato (kill-switch)");
}

/**
 * Kill-switch: no-op. Sempre sicuro da chiamare.
 */
export function resetVadState(): void {
  /* no-op — non c'è alcuno state interno da resettare */
}

/**
 * Kill-switch: il modello NON è mai caricato.
 * La pagina /diagnostics-vad usa questo per nascondere la sezione streaming.
 */
export function isVadLoaded(): boolean {
  return false;
}

/**
 * Kill-switch: no-op. Niente cache da pulire perché non scarichiamo nulla.
 */
export async function clearVadModelCache(): Promise<void> {
  /* no-op */
}

/**
 * Kill-switch: throw immediato.
 */
export async function runSyntheticTest(): Promise<{
  noise_prob: number;
  inference_ms: number;
}> {
  throw new Error("Silero VAD disattivato (kill-switch)");
}
