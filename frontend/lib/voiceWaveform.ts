/**
 * voiceWaveform.ts — Step 3 (Fase 4): blob audio-reactive.
 *
 * Singleton module that tracks the currently playing AI voice and exposes
 * a `getCurrentAmplitude()` function returning a [0..1] value in sync with
 * the audio playback time. Subscribed by OrganicBlob to drive its morph.
 *
 * Lifecycle:
 *   1. sendText() generates a UUID, calls `markPlaybackStart(id)`
 *   2. After audio starts, calls `fetchAndAttach(id)` which polls
 *      /api/converse-result/{id} until ready and stores the waveform.
 *   3. While playing, OrganicBlob calls `getCurrentAmplitude()` on each
 *      animation frame.
 *   4. Audio finishes / abort → `clear()` resets state.
 */
import { API_BASE } from "./api";

type Waveform = {
  values: number[];     // RMS per window, normalized [0..1]
  windowMs: number;     // duration of each window
  durationMs: number;   // total audio duration
  startedAt: number;    // Date.now() when playback began (approx)
};

let current: Waveform | null = null;
let currentId: string | null = null;

/** Generate a 32-char random hex UUID without external deps. */
export function newId(): string {
  // crypto.randomUUID exists in modern RN runtimes, but not always.
  try {
    // @ts-ignore — present in JSC/Hermes >= recent versions
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
  } catch {}
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/**
 * Called by the player as soon as playback starts. From this moment on,
 * the blob can use `getCurrentAmplitude()` (initially returns 0 until
 * the waveform JSON arrives from the server — typically <500ms).
 */
export function markPlaybackStart(id: string): void {
  currentId = id;
  current = null;
}

/** Reset everything — call when audio finishes or is aborted. */
export function clear(): void {
  current = null;
  currentId = null;
}

/**
 * Pull the waveform JSON from the server. Polls with backoff if the
 * audio is still being generated server-side (ready: false).
 *
 * Note: this is fire-and-forget. The caller doesn't await; the waveform
 * just "shows up" when ready and the blob picks it up on its next frame.
 */
export async function fetchAndAttach(id: string): Promise<void> {
  if (!id) return;
  const myId = id;
  const startedAt = Date.now();
  let backoff = 150;
  // Try for up to ~10s (audio is usually <5s, so we have margin).
  for (let attempt = 0; attempt < 30; attempt++) {
    // If a newer request superseded us, abort.
    if (currentId !== myId) return;
    try {
      const r = await fetch(`${API_BASE}/converse-result/${myId}`, { method: "GET" });
      if (r.ok) {
        const data = await r.json();
        if (data && data.ready === true && Array.isArray(data.waveform)) {
          // Lock in the waveform — only if we're still the active id.
          if (currentId === myId) {
            current = {
              values: data.waveform as number[],
              windowMs: Number(data.window_ms) || 50,
              durationMs: Number(data.duration_ms) || (data.waveform.length * 50),
              startedAt,
            };
          }
          return;
        }
      }
    } catch {
      // network error — back off and retry
    }
    await new Promise((res) => setTimeout(res, backoff));
    backoff = Math.min(500, Math.floor(backoff * 1.4));
  }
}

/**
 * Returns a [0..1] amplitude value for the current playback position.
 * If no waveform is loaded yet OR no playback is active, returns null
 * (caller should fall back to procedural animation).
 *
 * We also gently amplify the curve so even quieter speech makes the blob
 * pulse visibly. RMS values from TTS speech rarely exceed ~0.25, so we
 * map [0..0.3] → [0..1].
 */
export function getCurrentAmplitude(): number | null {
  if (!current) return null;
  const elapsed = Date.now() - current.startedAt;
  if (elapsed < 0) return 0;
  if (elapsed > current.durationMs + 200) return null; // playback past the end
  const idx = Math.floor(elapsed / current.windowMs);
  if (idx < 0 || idx >= current.values.length) return null;
  const raw = current.values[idx];
  // Map [0..0.30] → [0..1], clip to 1.
  const mapped = Math.min(1, raw / 0.30);
  // Slight curve to make low-amplitude speech feel more "alive".
  return Math.pow(mapped, 0.7);
}

/** Is a waveform currently loaded (ready to drive the blob)? */
export function hasWaveform(): boolean {
  return current !== null;
}
