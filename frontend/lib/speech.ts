/**
 * L'Amico Fraterno — Speech (TTS) module.
 *
 * Migrated from expo-av → expo-audio (SDK 54).
 * Public API (`SpeechMod`, `unlockSpeech`, `setDefaultVoiceId`) is unchanged.
 *
 * Why the migration:
 *  - expo-av's `Audio.Sound` would occasionally hold onto the AVAudioSession
 *    after `unloadAsync()`, blocking subsequent recordings (the "mic frozen
 *    after a few turns" bug).
 *  - expo-audio's SharedObject system tears down AVPlayer + AVAudioSession
 *    deterministically when `player.remove()` is called.
 *
 * - Primary: ElevenLabs via backend `/api/tts/*` (natural Italian voice).
 * - Fallback: expo-speech / Web Speech API (robotic but always works).
 */
import * as Speech from "expo-speech";
import {
  createAudioPlayer,
  setAudioModeAsync,
} from "expo-audio";
import { Platform } from "react-native";
import type { Tone } from "./api";
import { API_BASE } from "./api";
import * as voiceWaveform from "./voiceWaveform";

let speakingNow = false;
let webUnlocked = false;
let cachedVoices: SpeechSynthesisVoice[] = [];

// Currently playing native AudioPlayer instance (so we can stop it mid-speech).
// `any` because the official `AudioPlayer` class is exported as a type but the
// constructor we call lives behind `createAudioPlayer()`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentPlayer: any = null;
// Currently playing web <audio> element (for barge-in).
let currentWebAudio: HTMLAudioElement | null = null;
// Abort controller for in-flight TTS network requests (so stop() cancels them too).
let currentAbort: AbortController | null = null;

// Module-level handles per stallWatcher/safetyTimer per evitare zombie intervals.
let activeStallWatcher: ReturnType<typeof setInterval> | null = null;
let activeSafetyTimer: ReturnType<typeof setTimeout> | null = null;

// Configurable per-call voice id (can be overriden via speak() opts).
let defaultVoiceId: string | null = null;

export function setDefaultVoiceId(id: string | null | undefined) {
  defaultVoiceId = id || null;
}

// ---------- Web Speech fallback helpers ----------
function loadWebVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve([]);
      return;
    }
    const got = window.speechSynthesis.getVoices();
    if (got && got.length) {
      cachedVoices = got;
      resolve(got);
      return;
    }
    const handler = () => {
      cachedVoices = window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = null;
      resolve(cachedVoices);
    };
    window.speechSynthesis.onvoiceschanged = handler;
    setTimeout(() => {
      if (cachedVoices.length === 0) {
        cachedVoices = window.speechSynthesis.getVoices();
        resolve(cachedVoices);
      }
    }, 1500);
  });
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  if (!cachedVoices.length) return undefined;
  const langLow = lang.toLowerCase();
  const exact = cachedVoices.find((v) => v.lang?.toLowerCase() === langLow);
  if (exact) return exact;
  const baseLang = langLow.split("-")[0];
  const startsWith = cachedVoices.find((v) => v.lang?.toLowerCase().startsWith(baseLang));
  return startsWith;
}

/**
 * Unlock audio on first user gesture (needed for web Speech and web <audio>).
 */
export async function unlockSpeech(): Promise<void> {
  if (Platform.OS !== "web") return;
  if (webUnlocked) return;
  if (typeof window === "undefined") return;
  try {
    if ("speechSynthesis" in window) {
      await loadWebVoices();
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      u.rate = 1;
      window.speechSynthesis.speak(u);
    }
    try {
      const a = getWebAudioEl();
      if (a) {
        a.muted = true;
        a.volume = 0;
        a.src =
          "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
        await a.play().catch(() => {});
        try { a.pause(); } catch {}
        try { a.currentTime = 0; } catch {}
        a.muted = false;
        a.volume = 1.0;
      }
    } catch {}
    webUnlocked = true;
  } catch {
    webUnlocked = true;
  }
}

// ---------- Utility: stop everything ----------
function stopAllPlayback() {
  // Clear zombie intervals/timer
  if (activeStallWatcher) {
    try { clearInterval(activeStallWatcher); } catch {}
    activeStallWatcher = null;
  }
  if (activeSafetyTimer) {
    try { clearTimeout(activeSafetyTimer); } catch {}
    activeSafetyTimer = null;
  }

  // Stop in-flight TTS request
  try {
    currentAbort?.abort();
  } catch {}
  currentAbort = null;

  // Stop native AudioPlayer (expo-audio) — fire-and-forget.
  if (currentPlayer) {
    const p = currentPlayer;
    currentPlayer = null;
    try {
      p.pause?.();
    } catch {}
    // `remove()` releases the SharedObject and tears down the AVPlayer.
    try {
      p.remove?.();
    } catch {}
  }

  // Stop web <audio>
  if (currentWebAudio) {
    try {
      currentWebAudio.pause();
    } catch {}
    currentWebAudio = null;
  }

  // Stop system TTS (fallback path)
  try {
    if (Platform.OS === "web" && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    } else {
      Speech.stop();
    }
  } catch {}

  speakingNow = false;
}

// ---------- ElevenLabs path ----------
async function fetchTTSBytes(
  text: string,
  voiceId: string | null,
  tone: Tone | null | undefined,
  signal: AbortSignal
): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(`${API_BASE}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: voiceId || undefined,
        tone: tone || undefined,
      }),
      signal,
    });
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch {
    return null;
  }
}

function buildStreamUrl(
  text: string,
  voiceId: string | null,
  tone: Tone | null | undefined
): string {
  const params = new URLSearchParams();
  params.set("text", text);
  if (voiceId) params.set("voice_id", voiceId);
  if (tone) params.set("tone", tone);
  return `${API_BASE}/tts/stream?${params.toString()}`;
}

async function prepareTTSUrl(
  text: string,
  voiceId: string | null,
  tone: Tone | null | undefined,
  signal: AbortSignal
): Promise<string | null> {
  try {
    const r = await fetch(`${API_BASE}/tts/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: voiceId || undefined,
        tone: tone || undefined,
      }),
      signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data?.token) return null;
    return `${API_BASE}/tts/audio/${data.token}.mp3`;
  } catch {
    return null;
  }
}

async function playElevenLabsNativeFromUrl(audioUrl: string): Promise<boolean> {
  // 1. Switch the audio session into PLAYBACK mode (recording=false).
  try {
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch (e) {
    console.warn("[speech] setAudioModeAsync(playback) failed", e);
  }

  return await new Promise<boolean>((resolve) => {
    let done = false;
    let everPlayed = false;
    let everLoaded = false;
    let lastProgressAt = Date.now();
    let lastPositionSec = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let player: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let subscription: any = null;

    const cleanup = () => {
      try { subscription?.remove?.(); } catch {}
      subscription = null;
      if (player && currentPlayer === player) currentPlayer = null;
      try { player?.pause?.(); } catch {}
      try { player?.remove?.(); } catch {}
      player = null;
    };

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (activeStallWatcher) { try { clearInterval(activeStallWatcher); } catch {}; activeStallWatcher = null; }
      if (activeSafetyTimer) { try { clearTimeout(activeSafetyTimer); } catch {}; activeSafetyTimer = null; }
      cleanup();
      resolve(ok);
    };

    try {
      // createAudioPlayer accepts an AudioSource (URI string OR {uri:'...'}).
      // Passing the bare URL keeps things simple and lets the native player
      // stream MP3 chunks as they arrive.
      player = createAudioPlayer(audioUrl, { updateInterval: 250 });
      currentPlayer = player;

      subscription = player.addListener("playbackStatusUpdate", (status: any) => {
        if (status?.isLoaded) {
          everLoaded = true;
          const pos = status.currentTime ?? 0;
          // Step 3 — Push playback position to voiceWaveform so the blob
          // can pulse in sync with the actual audio playhead.
          try {
            voiceWaveform.notifyPlaybackTime(pos, !!status.playing, typeof status.duration === "number" ? status.duration : undefined);
          } catch {}
          if (pos > lastPositionSec) {
            lastPositionSec = pos;
            lastProgressAt = Date.now();
          }
          if (status.playing || pos > 0) {
            everPlayed = true;
          }
          if (status.didJustFinish) {
            finish(true);
            return;
          }
        }
      });

      // Stall-watcher: chiude solo se davvero bloccato per >12s dopo l'inizio
      const stallWatcher = setInterval(() => {
        if (done) {
          clearInterval(stallWatcher);
          if (activeStallWatcher === stallWatcher) activeStallWatcher = null;
          return;
        }
        if (!everPlayed) return;
        const stalled = Date.now() - lastProgressAt;
        if (stalled > 12000) {
          clearInterval(stallWatcher);
          if (activeStallWatcher === stallWatcher) activeStallWatcher = null;
          console.warn(`[speech] stalled ${stalled}ms after position ${lastPositionSec}s — assuming complete`);
          finish(true);
        }
      }, 1000);
      activeStallWatcher = stallWatcher;

      const safetyTimer = setTimeout(() => {
        clearInterval(stallWatcher);
        if (activeStallWatcher === stallWatcher) activeStallWatcher = null;
        if (activeSafetyTimer === safetyTimer) activeSafetyTimer = null;
        finish(everLoaded);
      }, 45000);
      activeSafetyTimer = safetyTimer;

      // Kick off playback. expo-audio AudioPlayer starts buffering on creation
      // and we explicitly call play() to begin output.
      try {
        player.play();
      } catch (e) {
        console.warn("[speech] player.play() threw", e);
        finish(false);
      }
    } catch (e) {
      console.warn("[speech] createAudioPlayer failed", e);
      finish(false);
    }
  });
}

// Persistent <audio> element for web — Safari requires the audio element
// to be reused (not recreated) for subsequent plays to work without
// requiring a fresh user gesture each time.
let webAudioEl: HTMLAudioElement | null = null;

function getWebAudioEl(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (!webAudioEl) {
    try {
      webAudioEl = new Audio();
      webAudioEl.preload = "auto";
      (webAudioEl as any).playsInline = true;
      webAudioEl.setAttribute("playsinline", "true");
      webAudioEl.setAttribute("webkit-playsinline", "true");
    } catch {
      webAudioEl = null;
    }
  }
  return webAudioEl;
}

async function playElevenLabsWeb(audioBuf: ArrayBuffer): Promise<boolean> {
  try {
    const a = getWebAudioEl();
    if (!a) return false;
    const blob = new Blob([audioBuf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    try { a.pause(); } catch {}
    try { a.currentTime = 0; } catch {}
    const prevUrl = a.src;
    a.src = url;
    a.muted = false;
    a.volume = 1.0;
    currentWebAudio = a;

    return await new Promise<boolean>((resolve) => {
      let done = false;
      const cleanup = () => {
        try { URL.revokeObjectURL(url); } catch {}
        if (prevUrl && prevUrl.startsWith("blob:")) {
          try { URL.revokeObjectURL(prevUrl); } catch {}
        }
        if (currentWebAudio === a) currentWebAudio = null;
      };
      const onEnded = () => {
        if (!done) {
          done = true;
          a.removeEventListener("ended", onEnded);
          a.removeEventListener("error", onError);
          cleanup();
          resolve(true);
        }
      };
      const onError = () => {
        if (!done) {
          done = true;
          a.removeEventListener("ended", onEnded);
          a.removeEventListener("error", onError);
          cleanup();
          resolve(false);
        }
      };
      a.addEventListener("ended", onEnded);
      a.addEventListener("error", onError);
      a.play().catch((e) => {
        console.warn("[speech] web audio play() blocked", e);
        if (!done) {
          done = true;
          a.removeEventListener("ended", onEnded);
          a.removeEventListener("error", onError);
          cleanup();
          resolve(false);
        }
      });
    });
  } catch (e) {
    console.warn("[speech] playElevenLabsWeb error", e);
    return false;
  }
}

// ---------- Fallback (expo-speech / Web Speech API) ----------
function fallbackSpeak(text: string, lang: string, tone: Tone): Promise<void> {
  return new Promise(async (resolve) => {
    let pitch = 1.0;
    let rate = 1.0;
    switch (tone) {
      case "calm": pitch = 0.97; rate = 0.95; break;
      case "warm": pitch = 1.0; rate = 0.97; break;
      case "energetic": pitch = 1.08; rate = 1.04; break;
      case "concerned": pitch = 0.95; rate = 0.96; break;
      case "urgent": pitch = 1.1; rate = 1.06; break;
      default: pitch = 1.0; rate = 1.0;
    }
    const finished = () => {
      speakingNow = false;
      resolve();
    };
    try {
      if (Platform.OS === "web" && typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        if (!cachedVoices.length) await loadWebVoices();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        u.pitch = pitch;
        u.rate = rate;
        u.volume = 1.0;
        const v = pickVoice(lang);
        if (v) u.voice = v;
        u.onend = finished;
        u.onerror = finished;
        speakingNow = true;
        window.speechSynthesis.speak(u);
        const timeoutMs = Math.min(60000, Math.max(4000, text.length * 100));
        setTimeout(() => {
          if (speakingNow) {
            try { window.speechSynthesis.cancel(); } catch {}
            finished();
          }
        }, timeoutMs);
        return;
      }
      try { Speech.stop(); } catch {}
      speakingNow = true;
      Speech.speak(text, {
        language: lang === "it" ? "it-IT" : lang,
        pitch,
        rate,
        onDone: finished,
        onStopped: finished,
        onError: finished,
      });
    } catch {
      finished();
    }
  });
}

// ---------- Public API ----------
export const SpeechMod = {
  isSpeaking(): boolean {
    return speakingNow;
  },
  stop(): void {
    stopAllPlayback();
  },
  setDefaultVoiceId(id: string | null | undefined) {
    setDefaultVoiceId(id);
  },
  /**
   * Play an already-generated audio stream from a URL (e.g. the new
   * /api/converse-stream-audio endpoint). Bypasses ElevenLabs/text logic —
   * just hands the URL to the platform audio player.
   *
   * Returns true on successful playback to end, false on error/cancel.
   */
  async playFromUrl(url: string): Promise<boolean> {
    if (!url) return false;
    stopAllPlayback();
    speakingNow = true;
    const ac = new AbortController();
    currentAbort = ac;
    try {
      if (Platform.OS === "web") {
        // Fetch as bytes then play (we already have a helper for that).
        try {
          const r = await fetch(url, { signal: ac.signal });
          if (!r.ok) {
            speakingNow = false;
            return false;
          }
          const buf = await r.arrayBuffer();
          if (ac.signal.aborted) {
            speakingNow = false;
            return false;
          }
          const ok = await playElevenLabsWeb(buf);
          speakingNow = false;
          return ok;
        } catch {
          speakingNow = false;
          return false;
        }
      }
      // Native: hand URL to AVPlayer-backed expo-audio AudioPlayer.
      const ok = await playElevenLabsNativeFromUrl(url);
      speakingNow = false;
      return ok;
    } finally {
      if (currentAbort === ac) currentAbort = null;
    }
  },
  async speak(
    text: string,
    opts: { language?: string; tone?: Tone | null; voiceId?: string | null; useElevenLabs?: boolean } = {}
  ): Promise<void> {
    if (!text) return;
    const lang = opts.language || "it-IT";
    const tone = (opts.tone || "neutral") as Tone;
    const useEleven = opts.useElevenLabs !== false; // default ON

    stopAllPlayback();

    const ac = new AbortController();
    currentAbort = ac;
    const cancelled = () => ac.signal.aborted;

    if (useEleven) {
      speakingNow = true;
      const voiceArg = opts.voiceId ?? defaultVoiceId;
      let ok = false;

      if (Platform.OS === "web") {
        const buf = await fetchTTSBytes(text, voiceArg, tone, ac.signal);
        if (cancelled()) {
          speakingNow = false;
          return;
        }
        if (currentAbort === ac) currentAbort = null;
        if (buf && buf.byteLength > 0) {
          ok = await playElevenLabsWeb(buf);
        }
      } else {
        // Native (iOS/Android) — STREAMING FIRST.
        //
        // Why streaming-primary now (Step 2a — Fase 4):
        //   Old flow: `/tts/prepare` waits for ElevenLabs to generate the WHOLE
        //   MP3 server-side (3-5s), THEN returns a token, THEN client downloads.
        //   The user heard nothing for 5-7 seconds after the AI "started speaking".
        //
        //   New flow: `/tts/stream` opens an ElevenLabs streaming connection on
        //   the server and pipes MP3 chunks back over HTTP chunked-transfer as
        //   they arrive (~300ms TTFB with eleven_flash_v2_5). expo-audio's
        //   AVPlayer-backed `createAudioPlayer(url)` starts playback as soon as
        //   the first audio chunk lands in its buffer (~500ms total).
        //
        //   Result: latency from "AI starts speaking" → "you hear voice" drops
        //   from ~5s to ~0.5s.
        //
        // Prepared-file path is kept ONLY as fallback (e.g. if Range requests
        // get blocked by a CDN, or if streaming connection fails mid-air).
        const streamUrl = buildStreamUrl(text, voiceArg, tone);
        ok = await playElevenLabsNativeFromUrl(streamUrl);
        if (cancelled()) {
          speakingNow = false;
          return;
        }
        if (currentAbort === ac) currentAbort = null;
        // Fallback: prepared-file path (slower but more resilient on bad networks).
        if (!ok && !cancelled()) {
          console.warn("[speech] streaming TTS failed, falling back to /tts/prepare");
          const url = await prepareTTSUrl(text, voiceArg, tone, ac.signal);
          if (url) {
            ok = await playElevenLabsNativeFromUrl(url);
          }
        }
      }

      speakingNow = false;
      if (cancelled()) return;
      if (ok) return;
    }

    if (cancelled()) return;
    await fallbackSpeak(text, lang, tone);
  },
};
