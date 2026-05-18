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
let lastDurationSec = 0;  // total audio duration as reported by AVPlayer
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
 *
 * `durationSec` (optional): the AVPlayer's reported total audio duration.
 * Used for fraction-based waveform indexing (more robust than time-based,
 * because per-sentence MP3 concatenation can yield a server-side waveform
 * whose nominal duration doesn't match the real playback duration).
 */
export function notifyPlaybackTime(positionSec: number, playing: boolean, durationSec?: number): void {
  if (typeof positionSec !== "number" || positionSec < 0) return;
  lastPlaybackSec = positionSec;
  lastPlaybackAtMs = Date.now();
  isPlaying = playing;
  if (typeof durationSec === "number" && durationSec > 0.1 && isFinite(durationSec)) {
    lastDurationSec = durationSec;
  }
}

/**
 * Fetch the waveform JSON from the server.
 *
 * Two-phase strategy (Step 3 — Fase 4):
 *   1. POLL until `ready: true` (waveform — possibly partial — is available).
 *      The server publishes progressive updates every ~700ms while streaming.
 *   2. KEEP POLLING until `partial: false` (full waveform locked in) OR
 *      until `clear()` is called (audio ended).
 *
 * Each successful poll REPLACES the in-memory waveform with the latest
 * server-side snapshot, so the blob's amplitude lookup always uses the
 * largest array available.
 */
export async function fetchAndAttach(id: string): Promise<void> {
  if (!id) return;
  const myId = id;
  let backoff = 120;
  let gotFirst = false;
  let pollsSinceFinal = 0;
  // Up to ~25s of polling (covers very long replies). The blob loop calls
  // `clear()` at end-of-playback which short-circuits this loop.
  for (let attempt = 0; attempt < 80; attempt++) {
    if (currentId !== myId) return; // superseded
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
            if (!gotFirst) {
              gotFirst = true;
              console.log(
                `[voiceWaveform] FIRST waveform: ${current.values.length} pts, ${current.durationMs}ms (partial=${!!data.partial})`,
              );
            }
            // Once the server marks partial:false (final cut), poll just
            // 1-2 more times and stop — nothing else will change.
            if (data.partial === false || data.partial === undefined) {
              pollsSinceFinal++;
              if (pollsSinceFinal >= 2) return;
            }
          }
        }
      }
    } catch {
      // network — retry
    }
    await new Promise((res) => setTimeout(res, backoff));
    // Faster polling once we have first data; slower while we wait.
    backoff = gotFirst ? 500 : Math.min(400, Math.floor(backoff * 1.4));
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
  const effectiveSec = lastPlaybackSec + (isPlaying ? sinceUpdateMs / 1000 : 0);
  if (effectiveSec < 0) return 0;

  // === FRACTION-BASED INDEXING ===
  // Server-side waveform duration (nominal) is computed by summing per-sentence
  // MP3 durations as reported by pydub. This can drift from the real AVPlayer
  // duration (concatenated MP3 frames are sometimes counted weirdly). We use
  // the AVPlayer's reported duration (lastDurationSec) as the SOURCE OF TRUTH
  // and map [0..1] playback fraction → waveform[0..length].
  // Fallback to time-based indexing if duration isn't known yet.
  let idx: number;
  if (lastDurationSec > 0.1) {
    const fraction = Math.max(0, Math.min(1, effectiveSec / lastDurationSec));
    idx = Math.floor(fraction * current.values.length);
  } else {
    idx = Math.floor((effectiveSec * 1000) / current.windowMs);
  }
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
