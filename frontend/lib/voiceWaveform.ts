/**
 * voiceWaveform.ts — Step 3 (Fase 4): blob audio-reactive.
 *
 * Singleton module that tracks the currently playing AI voice and exposes
 * a `getCurrentAmplitude()` function returning a [0..1] value in sync with
 * the audio playback time. Subscribed by OrganicBlob to drive its morph.
 *
 * ARCHITECTURE:
 *  - `lib/speech.ts` is the SOURCE OF TRUTH for playback time. It owns the
 *    expo-audio AudioPlayer and receives `playbackStatusUpdate` events with
 *    `currentTime`. On each update it calls `notifyPlaybackTime(seconds)`.
 *  - Between status updates (which fire ~4Hz @ updateInterval: 250ms), we
 *    interpolate using `Date.now()` so the blob animates at the full UI
 *    framerate without visible stepping.
 *  - The server-side waveform JSON arrives asynchronously (~300-800ms after
 *    audio starts streaming). When it lands we lock it in and the blob
 *    starts pulsing on REAL syllables.
 */
import { API_BASE } from "./api";

type Waveform = {
  values: number[];     // RMS per window, normalized [0..1]
  windowMs: number;     // duration of each window
  durationMs: number;   // total audio duration
};

let current: Waveform | null = null;
let currentId: string | null = null;

// Last reported AVPlayer position + when we received it.
let lastPlaybackSec = 0;
let lastPlaybackAtMs = 0;
let isPlaying = false;

/** Generate a 32-char random hex UUID without external deps. */
export function newId(): string {
  try {
    // @ts-ignore — present in Hermes recent versions
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
  } catch {}
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/**
 * Called by app/index.tsx as soon as it starts the playback request.
 * Resets state; the actual playback time comes from speech.ts later.
 */
export function markPlaybackStart(id: string): void {
  currentId = id;
  current = null;
  lastPlaybackSec = 0;
  lastPlaybackAtMs = 0;
  isPlaying = false;
}

/** Reset everything — call when audio finishes or is aborted. */
export function clear(): void {
  current = null;
  currentId = null;
  lastPlaybackSec = 0;
  lastPlaybackAtMs = 0;
  isPlaying = false;
}

/**
 * Called by speech.ts on every `playbackStatusUpdate` event from the
 * AudioPlayer. Lets us know precisely where the audio playhead is.
 */
export function notifyPlaybackTime(positionSec: number, playing: boolean): void {
  if (typeof positionSec !== "number" || positionSec < 0) return;
  lastPlaybackSec = positionSec;
  lastPlaybackAtMs = Date.now();
  isPlaying = playing;
}

/**
 * Fetch the waveform JSON from the server. Polls with backoff if the
 * audio is still being generated server-side (ready: false).
 */
export async function fetchAndAttach(id: string): Promise<void> {
  if (!id) return;
  const myId = id;
  let backoff = 150;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (currentId !== myId) return;  // superseded
    try {
      const r = await fetch(`${API_BASE}/converse-result/${myId}`, { method: "GET" });
      if (r.ok) {
        const data = await r.json();
        if (data && data.ready === true && Array.isArray(data.waveform)) {
          if (currentId === myId) {
            current = {
              values: data.waveform as number[],
              windowMs: Number(data.window_ms) || 50,
              durationMs: Number(data.duration_ms) || (data.waveform.length * 50),
            };
            console.log(
              `[voiceWaveform] waveform attached: ${current.values.length} pts, ${current.durationMs}ms`,
            );
          }
          return;
        }
      }
    } catch {
      // network — retry
    }
    await new Promise((res) => setTimeout(res, backoff));
    backoff = Math.min(500, Math.floor(backoff * 1.4));
  }
}

/**
 * Returns a [0..1] amplitude value for the current playback position.
 * Uses the last reported AudioPlayer time + monotonic interpolation
 * between status updates (which fire every ~250ms).
 *
 * Returns null if:
 *  - no waveform is loaded yet (caller falls back to procedural anim)
 *  - playback has ended (past duration)
 */
export function getCurrentAmplitude(): number | null {
  if (!current) return null;
  if (lastPlaybackAtMs === 0) return null;  // no playback time received yet
  // Interpolate playback time forward since the last status update.
  const sinceUpdateMs = Date.now() - lastPlaybackAtMs;
  const effectiveMs = lastPlaybackSec * 1000 + (isPlaying ? sinceUpdateMs : 0);
  if (effectiveMs < 0) return 0;
  if (effectiveMs > current.durationMs + 200) return null; // past the end
  const idx = Math.floor(effectiveMs / current.windowMs);
  if (idx < 0 || idx >= current.values.length) return null;
  const raw = current.values[idx];
  // Map [0..0.30] → [0..1], clip; gentle curve for low-end emphasis.
  const mapped = Math.min(1, raw / 0.30);
  return Math.pow(mapped, 0.7);
}

/** Is a waveform currently loaded (ready to drive the blob)? */
export function hasWaveform(): boolean {
  return current !== null;
}
