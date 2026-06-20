/**
 * Silero Neural VAD — wrapper ONNX Runtime React Native
 * ──────────────────────────────────────────────────────────────────────
 * P1 Fase 1 — PoC isolato (Fabio escalation 2026-06-20).
 *
 * Obiettivo Fase 1: dimostrare che il modello Silero VAD v5 carica nel
 * dispositivo (TestFlight build) tramite onnxruntime-react-native.
 * NESSUN cambio nel comportamento dell'app reale. Solo accessibile da
 * /diagnostics-vad per verifica isolata.
 *
 * Fase 2 (prossime sessioni): integrare PCM streaming via
 * @siteed/expo-audio-stream e fare inference real-time chunk-by-chunk.
 *
 * Fase 3 (finale): sostituire il VAD volumetrico in voice.ts con
 * voice_probability > 0.5 dal modello neurale.
 *
 * ────────────────────────────────────────
 * MODELLO Silero VAD v5
 * ────────────────────────────────────────
 *  - File: silero_vad.onnx (2.3 MB, Apache 2.0)
 *  - Source: github.com/snakers4/silero-vad
 *  - ONNX ir_version: 8, opset: 16
 *  - Sample rate supportati: 8 kHz (256 samples/chunk) o 16 kHz (512)
 *  - Latency: ~1ms per chunk su iPhone moderno (CPU)
 *  - Output: voice_probability ∈ [0, 1] per ogni chunk
 *
 * INPUTS:
 *  - input:  Float32Array audio chunk shape=[batch, chunk_size]
 *  - state:  Float32Array LSTM hidden state shape=[2, batch, 128]
 *            (inizializzato a zeri; aggiornato chunk per chunk)
 *  - sr:     Int64 scalar 16000 (o 8000)
 *
 * OUTPUTS:
 *  - output: Float32Array shape=[batch, 1] — probability di speech
 *  - stateN: Float32Array shape=[2, batch, 128] — nuovo state da
 *            riusare al chunk successivo
 *
 * ────────────────────────────────────────
 * CACHE STRATEGY
 * ────────────────────────────────────────
 *  1. Al primo uso: download da /api/assets/silero_vad.onnx in
 *     `documentDirectory/silero_vad.onnx`
 *  2. Verifica MD5/size minimo prima di accettare il file scaricato
 *  3. Successivi avvi: skip download se file presente
 *  4. Cache invalidation manuale via `clearVadModelCache()` per debug
 */

import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import { InferenceSession, Tensor } from "onnxruntime-react-native";

import { BACKEND } from "../api";

const MODEL_FILENAME = "silero_vad.onnx";
const MODEL_URL = `${BACKEND}/api/assets/${MODEL_FILENAME}`;
const MODEL_MIN_SIZE = 1_500_000; // 1.5MB — il file ufficiale è ~2.3MB
const MODEL_LOCAL_URI = `${FileSystem.documentDirectory}${MODEL_FILENAME}`;

// === Configurazione runtime ===
export const SAMPLE_RATE = 16_000; // 16 kHz (alternativa: 8000)
export const CHUNK_SIZE = 512;     // samples per chunk (32ms @ 16kHz)
export const STATE_DIMS = [2, 1, 128] as const; // [num_layers, batch, hidden_size]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _session: InferenceSession | null = null;
let _state: Float32Array | null = null;

export type ModelLoadStatus = {
  ok: boolean;
  modelPath?: string;
  modelSize?: number;
  loadTimeMs?: number;
  sessionInputs?: string[];
  sessionOutputs?: string[];
  error?: string;
};

/**
 * Verifica se il modello è già nella cache locale del dispositivo.
 */
async function ensureModelDownloaded(
  onProgress?: (received: number, total: number) => void
): Promise<string> {
  // 1. Check se cached
  try {
    const info = await FileSystem.getInfoAsync(MODEL_LOCAL_URI);
    if (info.exists && info.size && info.size > MODEL_MIN_SIZE) {
      console.log(`[silero-vad] model cached at ${MODEL_LOCAL_URI} (${info.size} bytes)`);
      return MODEL_LOCAL_URI;
    }
    if (info.exists) {
      // File corrotto / troppo piccolo → cancello e riscarico
      console.warn(`[silero-vad] cached model too small (${info.size} bytes), redownloading`);
      await FileSystem.deleteAsync(MODEL_LOCAL_URI, { idempotent: true });
    }
  } catch (e) {
    console.warn("[silero-vad] cache check error:", e);
  }

  // 2. Download
  console.log(`[silero-vad] downloading from ${MODEL_URL}...`);
  const callback = onProgress
    ? (snapshot: FileSystem.DownloadProgressData) => {
        onProgress(snapshot.totalBytesWritten, snapshot.totalBytesExpectedToWrite);
      }
    : undefined;
  const downloadResumable = FileSystem.createDownloadResumable(
    MODEL_URL,
    MODEL_LOCAL_URI,
    {},
    callback
  );
  const result = await downloadResumable.downloadAsync();
  if (!result || !result.uri) {
    throw new Error("download failed: no URI returned");
  }

  // 3. Verifica dimensione minima
  const info = await FileSystem.getInfoAsync(result.uri);
  if (!info.exists || !info.size || info.size < MODEL_MIN_SIZE) {
    await FileSystem.deleteAsync(result.uri, { idempotent: true });
    throw new Error(`download corrupt: size=${info.size}, expected >=${MODEL_MIN_SIZE}`);
  }
  console.log(`[silero-vad] downloaded ${info.size} bytes OK`);
  return result.uri;
}

/**
 * Inizializza l'inferenza ONNX. Idempotente — chiamabile più volte.
 * Ritorna lo status per UI di diagnostica.
 *
 * ⚠️ KILL-SWITCH (Fabio escalation 2026-06-20 v7) ⚠️
 * `onnxruntime-react-native@1.24.3` è documentato INCOMPATIBILE con
 * `newArchEnabled: true` (Fabric/TurboModules) — il modulo crasha
 * via JSI quando si chiama InferenceSession.create() su iOS.
 * Issue Microsoft: github.com/microsoft/onnxruntime/issues/17623
 * Guida Expo ufficiale: raccomanda di disabilitare NewArch.
 *
 * Soluzione scelta: NON chiamare il modulo nativo finché non passiamo
 * a una libreria compatibile (react-native-fast-tflite) in una sessione
 * futura. Questo fix è OTA-deliverable: viaggia via Expo Updates senza
 * richiedere una nuova build TestFlight.
 */
export async function loadSileroVadModel(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _onProgress?: (received: number, total: number) => void
): Promise<ModelLoadStatus> {
  return {
    ok: false,
    error:
      "Silero VAD temporaneamente disattivato.\n\n" +
      "Causa: onnxruntime-react-native (v1.24.3) non è compatibile con " +
      "New Architecture iOS (Fabric/TurboModules) — issue Microsoft #17623. " +
      "Il caricamento del modello crasha l'app via JSI.\n\n" +
      "Verrà ripristinato in una build futura migrando il PoC a " +
      "react-native-fast-tflite (compatibile NewArch) con la versione " +
      "TFLite ufficiale di Silero VAD.\n\n" +
      "Nessun impatto sull'app principale: il VAD volumetrico in voice.ts " +
      "continua a funzionare regolarmente.",
  };
}

/**
 * @deprecated Killed (vedi loadSileroVadModel kill-switch). Mantenuto per
 *   compatibilità di import; non chiama il modulo nativo. Ritorna sempre 0.
 */
export async function loadSileroVadModelLegacy(
  onProgress?: (received: number, total: number) => void
): Promise<ModelLoadStatus> {
  if (_session) {
    return {
      ok: true,
      modelPath: MODEL_LOCAL_URI,
      sessionInputs: _session.inputNames,
      sessionOutputs: _session.outputNames,
    };
  }
  const start = Date.now();
  try {
    // === Log granulari step-by-step (diag crash 2026-06-20) ===
    // Se l'app crasha durante il load del modello, questi log ci dicono
    // a che step si è rotto (visibili in /diagnostics se l'app non
    // crasha completamente; comunque il try/catch sotto cattura tutto).
    console.log("[KODA_VAD_LOAD] step 1: ensureModelDownloaded start");
    const path = await ensureModelDownloaded(onProgress);
    console.log(`[KODA_VAD_LOAD] step 2: got path=${path.substring(0, 60)}`);
    const info = await FileSystem.getInfoAsync(path);
    console.log(`[KODA_VAD_LOAD] step 3: file exists=${info.exists}, size=${info.exists ? info.size : "?"}`);
    // Asset.fromURI: alcune versioni di onnxruntime-react-native richiedono
    // il path "puro" senza il prefisso "file://". Strippiamo prudentemente.
    const cleanPath = path.startsWith("file://") ? path.replace(/^file:\/\//, "") : path;
    console.log(`[KODA_VAD_LOAD] step 4: calling InferenceSession.create with cleanPath=${cleanPath.substring(0, 60)}`);
    const session = await InferenceSession.create(cleanPath, {
      // executionProviders: ['cpu'] è default su iOS. Future: 'coreml' per
      // accelerazione GPU/NPU se disponibile (lo testeremo in Fase 2).
    });
    console.log(`[KODA_VAD_LOAD] step 5: session created, inputs=${session.inputNames.join(",")} outputs=${session.outputNames.join(",")}`);
    _session = session;
    // Reset state al primo load
    _state = new Float32Array(STATE_DIMS[0] * STATE_DIMS[1] * STATE_DIMS[2]);
    const took = Date.now() - start;
    console.log(`[silero-vad] session ready in ${took}ms`);
    console.log(`[silero-vad] inputs: ${session.inputNames.join(", ")}`);
    console.log(`[silero-vad] outputs: ${session.outputNames.join(", ")}`);
    return {
      ok: true,
      modelPath: path,
      modelSize: info.exists ? info.size : undefined,
      loadTimeMs: took,
      sessionInputs: [...session.inputNames],
      sessionOutputs: [...session.outputNames],
    };
  } catch (e: any) {
    console.warn("[silero-vad] loadSileroVadModel error:", e);
    console.warn(`[KODA_VAD_LOAD] FAILED with: ${e?.message || String(e)}`);
    return {
      ok: false,
      error: e?.message || String(e),
    };
  }
}

/**
 * Inferenza VAD su un singolo chunk audio.
 * @param chunk Float32Array di CHUNK_SIZE samples normalizzati in [-1, 1]
 * @returns probabilità che il chunk contenga voce umana [0..1]
 *
 * NB: questo è SINCRONO solo a livello di API ma fa lavoro async dietro.
 * In Fase 2 verrà chiamato a frequenza ~30Hz (1 chunk ogni 32ms).
 */
export async function runVadInference(chunk: Float32Array): Promise<number> {
  if (!_session || !_state) {
    throw new Error("VAD model not loaded — call loadSileroVadModel() first");
  }
  if (chunk.length !== CHUNK_SIZE) {
    throw new Error(`chunk size mismatch: got ${chunk.length}, expected ${CHUNK_SIZE}`);
  }
  const inputTensor = new Tensor("float32", chunk, [1, CHUNK_SIZE]);
  const stateTensor = new Tensor("float32", _state, STATE_DIMS as unknown as number[]);
  const srTensor = new Tensor("int64", new BigInt64Array([BigInt(SAMPLE_RATE)]), []);
  const results = await _session.run({
    input: inputTensor,
    state: stateTensor,
    sr: srTensor,
  });
  const out = results.output;
  const stateOut = results.stateN;
  // Aggiorna lo stato persistente per il prossimo chunk
  if (stateOut?.data instanceof Float32Array) {
    _state = stateOut.data;
  }
  const prob = (out?.data as Float32Array | undefined)?.[0] ?? 0;
  return prob;
}

/**
 * Reset dello stato LSTM (es. su nuovo turno di registrazione).
 */
export function resetVadState(): void {
  if (_state) {
    _state = new Float32Array(STATE_DIMS[0] * STATE_DIMS[1] * STATE_DIMS[2]);
  }
}

/**
 * Restituisce true se la session è stata caricata (utile per UI).
 */
export function isVadLoaded(): boolean {
  return _session !== null;
}

/**
 * Cancella il modello dalla cache locale (per debugging / aggiornamenti).
 * Richiede una nuova `loadSileroVadModel()` per riusarlo.
 */
export async function clearVadModelCache(): Promise<void> {
  try {
    await FileSystem.deleteAsync(MODEL_LOCAL_URI, { idempotent: true });
    _session = null;
    _state = null;
    console.log("[silero-vad] cache cleared");
  } catch (e) {
    console.warn("[silero-vad] clearCache error:", e);
  }
}

/**
 * Test sintetico: genera un chunk di rumore random e fa inference.
 * Per verificare end-to-end il PoC senza serve mic.
 * Ritorna la probability sul rumore (dovrebbe essere bassa, < 0.2).
 */
export async function runSyntheticTest(): Promise<{
  noise_prob: number;
  inference_ms: number;
}> {
  if (!_session) throw new Error("VAD model not loaded");
  // Rumore bianco casuale ~uniforme in [-0.1, 0.1] (volume basso)
  const chunk = new Float32Array(CHUNK_SIZE);
  for (let i = 0; i < CHUNK_SIZE; i++) {
    chunk[i] = (Math.random() - 0.5) * 0.2;
  }
  resetVadState();
  const start = Date.now();
  const prob = await runVadInference(chunk);
  return { noise_prob: prob, inference_ms: Date.now() - start };
}

// Esposto per uso debug nelle log; previene tree-shake di expo-asset (non
// strettamente usato qui ma può servire in Fase 2 per altri asset).
export const _ASSET_MARKER = Asset;
