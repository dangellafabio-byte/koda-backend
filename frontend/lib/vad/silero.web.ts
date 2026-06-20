/**
 * Silero VAD — stub WEB
 * ──────────────────────────────────────────────────────────────────────
 * onnxruntime-react-native è nativo-only e crasha sul bundle web.
 * Metro risolve automaticamente questo file con suffisso .web.ts
 * quando il target è web, mentre su iOS/Android prende il `silero.ts` reale.
 *
 * Il web rende solo la diagnostica visiva: model load button restituisce
 * un errore amichevole "non supportato su web".
 */

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

export async function loadSileroVadModel(
  _onProgress?: (received: number, total: number) => void
): Promise<ModelLoadStatus> {
  return {
    ok: false,
    error: "onnxruntime-react-native non disponibile su web. Apri da TestFlight (iOS).",
  };
}

export async function runVadInference(_chunk: Float32Array): Promise<number> {
  throw new Error("Silero VAD non disponibile su web");
}

export function resetVadState(): void {
  /* no-op on web */
}

export function isVadLoaded(): boolean {
  return false;
}

export async function clearVadModelCache(): Promise<void> {
  /* no-op on web */
}

export async function runSyntheticTest(): Promise<{
  noise_prob: number;
  inference_ms: number;
}> {
  throw new Error("Silero VAD non disponibile su web");
}
