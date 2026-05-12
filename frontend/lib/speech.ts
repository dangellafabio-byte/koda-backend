/**
 * Taccuino Vivo — Speech (TTS) module.
 *
 * - Primary: ElevenLabs via backend `/api/tts` (natural Italian voice).
 * - Fallback: expo-speech / Web Speech API (robotic but always works).
 *
 * The `speak()` function is the single entry point; callers just await it.
 * Callers can call `SpeechMod.stop()` at any time to cut off the current
 * utterance (supports barge-in).
 */
import * as Speech from "expo-speech";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import type { Tone } from "./api";
import { API_BASE } from "./api";

let speakingNow = false;
let webUnlocked = false;
let cachedVoices: SpeechSynthesisVoice[] = [];

// Currently playing native Sound instance (so we can stop it mid-speech).
let currentSound: Audio.Sound | null = null;
// Currently playing web <audio> element (for barge-in).
let currentWebAudio: HTMLAudioElement | null = null;
// Abort controller for in-flight TTS network requests (so stop() cancels them too).
let currentAbort: AbortController | null = null;

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
 * Unlock audio on first user gesture (needed for both web Speech and web <audio>).
 * On Safari this MUST be called synchronously inside the first user gesture
 * handler so the persistent <audio> element gets the "unlocked" status.
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
    // Eagerly create the persistent <audio> element and play a tiny silent
    // burst so Safari marks it as "unlocked" — afterwards setting .src and
    // calling .play() works without requiring a fresh user gesture each time.
    try {
      const a = getWebAudioEl();
      if (a) {
        a.muted = true;
        a.volume = 0;
        // 1-second silent WAV (44100Hz mono PCM with zeros)
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
  // Stop in-flight TTS request
  try {
    currentAbort?.abort();
  } catch {}
  currentAbort = null;

  // Stop native Sound
  if (currentSound) {
    const s = currentSound;
    currentSound = null;
    (async () => {
      try { await s.stopAsync(); } catch {}
      try { await s.unloadAsync(); } catch {}
    })();
  }

  // Stop web <audio> — just pause, don't clear src (Safari throws an error
  // event when src="" and may refuse subsequent plays on the same element).
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  // Fast path: TextDecoder + btoa (works on iOS / Hermes; ~20x faster than
  // the chunked apply approach below)
  try {
    if (typeof TextDecoder !== "undefined" && typeof btoa !== "undefined") {
      const decoder = new TextDecoder("latin1");
      const binary = decoder.decode(new Uint8Array(buffer));
      return btoa(binary);
    }
  } catch {}
  // Fallback: chunked String.fromCharCode (slower but always works)
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x4000; // 16k — safer than 32k on some JS engines
  for (let i = 0; i < bytes.length; i += chunkSize) {
    // @ts-ignore
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  if (typeof btoa !== "undefined") return btoa(binary);
  // @ts-ignore
  return global.btoa ? global.btoa(binary) : "";
}

/**
 * Generate TTS on the backend and return a direct GET URL where Audio.Sound
 * can stream the MP3. This bypasses base64 encoding and FileSystem writes,
 * which on iOS Expo Go cause AVFoundationErrorDomain -11800 errors when
 * Audio.Sound tries to load the resulting file.
 *
 * SPEED OPTIMIZATION: returns the STREAMING URL (/tts/stream) instead of
 * waiting for /tts/prepare to finish generating the entire MP3 server-side.
 * Audio.Sound can start playback as soon as the first MP3 frames arrive.
 */
function buildStreamUrl(
  text: string,
  voiceId: string | null,
  tone: Tone | null | undefined
): string {
  // We embed params in URL so Audio.Sound's HTTP GET (which is hard to
  // customize with POST body) can fetch the stream. Backend supports GET
  // with body via x-www-form-urlencoded — but simpler: we expose a POST
  // endpoint and just preload the URL via HEAD/GET. The actual audio fetch
  // uses POST below.
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
  // SPEED PATH: ricorri a /tts/prepare solo come fallback. Il path primario
  // ora è il diretto streaming via /tts/stream — Audio.Sound carica
  // l'URL HTTP e inizia il playback al primo chunk (~300-700ms vs 2-4s).
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
  try {
    // CRITICAL: switch audio session to playback mode so:
    // - hardware volume buttons control the playback volume (iOS)
    // - audio routes through the main speaker (not earpiece on Android)
    // - audio plays even with the silent switch on (iOS)
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      // Give iOS' AVAudioSession a tick to fully apply the new category
      await new Promise((r) => setTimeout(r, 60));
    } catch (e) {
      console.warn("[speech] setAudioModeAsync failed", e);
    }

    return await new Promise<boolean>((resolve) => {
      let done = false;
      let everPlayed = false;
      let everLoaded = false;
      let localSound: Audio.Sound | null = null;
      let lastProgressAt = Date.now();
      let lastPositionMs = 0;
      const cleanup = async () => {
        try { await localSound?.unloadAsync(); } catch {}
        if (currentSound === localSound) currentSound = null;
      };

      // FIX 3+6 (RCA): rimosso il setTimeout 2.5s che terminava il playback
      // ad ogni `isLoaded:false`. Cause vere di "cutoff mid-sentence":
      //   - AVPlayer su iOS emette isLoaded:false durante normali buffer
      //     underrun o cambi di chunk MP3, NON sono eventi terminali.
      //   - Il vero segnale di fine è SEMPRE `didJustFinish: true`.
      //
      // Nuova strategia:
      //   - `didJustFinish: true` → completato con successo (UNICA via)
      //   - `status.error` su un sound già caricato → errore reale → termina
      //   - Stallo: se posizione non avanza per >12s E lo stream sembra
      //     terminato (isLoaded:false persistente) → consideriamo terminato
      //   - safetyTimer 45s come ultimo guardrail
      const onStatus = (status: any) => {
        if (status.isLoaded) {
          everLoaded = true;
          const pos = status.positionMillis ?? 0;
          if (pos > lastPositionMs) {
            lastPositionMs = pos;
            lastProgressAt = Date.now();
          }
          if (status.isPlaying || pos > 0) {
            everPlayed = true;
          }
          if (status.didJustFinish) {
            if (!done) {
              done = true;
              cleanup().finally(() => resolve(true));
            }
            return;
          }
          if (status.error && !done) {
            console.warn("[speech] playback error", status.error);
            done = true;
            cleanup().finally(() => resolve(everPlayed));
          }
        }
        // isLoaded:false → NON terminiamo. Lasciamo a safetyTimer/stallWatch
        // il compito di chiudere se è davvero finito o bloccato.
      };

      // Stallo-watcher: ogni 1s controlla se la posizione è progredita.
      // Se non c'è progresso per >12s DOPO aver iniziato a suonare,
      // consideriamo terminato (probabilmente lo stream è finito senza
      // emettere didJustFinish — comportamento occasionale di AVPlayer).
      const stallWatcher = setInterval(() => {
        if (done) {
          clearInterval(stallWatcher);
          return;
        }
        if (!everPlayed) return; // non ha mai suonato → safetyTimer gestirà
        const stalled = Date.now() - lastProgressAt;
        if (stalled > 12000) {
          clearInterval(stallWatcher);
          if (!done) {
            done = true;
            console.warn(`[speech] stalled ${stalled}ms after position ${lastPositionMs}ms — assuming complete`);
            cleanup().finally(() => resolve(true));
          }
        }
      }, 1000);

      const safetyTimer = setTimeout(() => {
        clearInterval(stallWatcher);
        if (!done) {
          done = true;
          cleanup().finally(() => resolve(everLoaded));
        }
      }, 45000); // 45s max — risposte lunghe (~120 parole, ~20s di audio)

      // CRITICAL iOS FIX: register the playback status callback as the 3rd
      // parameter of createAsync (not via setOnPlaybackStatusUpdate after).
      // Audio.Sound loads MP3 directly from HTTP URL — most reliable path on iOS.
      Audio.Sound.createAsync(
        { uri: audioUrl },
        { shouldPlay: false, volume: 1.0 },
        onStatus,
      )
        .then(async (created) => {
          localSound = created.sound;
          currentSound = localSound;
          try {
            await localSound.playAsync();
          } catch (e) {
            console.warn("[speech] playAsync failed", e);
            if (!done) {
              done = true;
              clearTimeout(safetyTimer);
              clearInterval(stallWatcher);
              cleanup().finally(() => resolve(false));
            }
          }
        })
        .catch((e) => {
          console.warn("[speech] createAsync failed (URL)", e);
          if (!done) {
            done = true;
            clearTimeout(safetyTimer);
            clearInterval(stallWatcher);
            cleanup().finally(() => resolve(false));
          }
        });
    });
  } catch (e) {
    console.warn("[speech] playElevenLabsNativeFromUrl outer error", e);
    return false;
  }
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
      // Inline playback on iOS Safari (avoid full-screen takeover)
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
    // Stop any ongoing playback on this element first
    try { a.pause(); } catch {}
    try { a.currentTime = 0; } catch {}
    // Revoke previous blob URL if any
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
  async speak(
    text: string,
    opts: { language?: string; tone?: Tone | null; voiceId?: string | null; useElevenLabs?: boolean } = {}
  ): Promise<void> {
    if (!text) return;
    const lang = opts.language || "it-IT";
    const tone = (opts.tone || "neutral") as Tone;
    const useEleven = opts.useElevenLabs !== false; // default ON

    // Stop any existing playback before starting a new one. This also aborts
    // any in-flight TTS fetch from a PREVIOUS speak() call, causing it to bail.
    stopAllPlayback();

    // Each speak() call gets its OWN abort controller. If a later speak() call
    // (or .stop()) aborts this one, we must NOT fall back to expo-speech —
    // otherwise the user hears the robotic fallback OVERLAPPING with the new
    // voice they just selected.
    const ac = new AbortController();
    currentAbort = ac;

    // Helper: was this particular call cancelled?
    const cancelled = () => ac.signal.aborted;

    // Try ElevenLabs first
    if (useEleven) {
      speakingNow = true;
      const voiceArg = opts.voiceId ?? defaultVoiceId;
      let ok = false;

      if (Platform.OS === "web") {
        // Web: fetch bytes and play via Blob URL (streaming fetch + MediaSource
        // sarebbe ideale ma il fallback raw-bytes resta affidabile su Safari/Chrome).
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
        // Native (iOS/Android) — STREAMING PATH:
        // Build a GET URL for /tts/stream and let Audio.Sound consume it as
        // HTTP MP3 stream. iOS' AVPlayer / Android's MediaPlayer can start
        // playback after the first ~100ms of audio frames arrive — orders
        // of magnitude faster than waiting for /tts/prepare to finish.
        const streamUrl = buildStreamUrl(text, voiceArg, tone);
        ok = await playElevenLabsNativeFromUrl(streamUrl);
        // Fallback: if streaming had issues, try the buffered prepare path.
        if (!ok && !cancelled()) {
          const url = await prepareTTSUrl(text, voiceArg, tone, ac.signal);
          if (cancelled()) {
            speakingNow = false;
            return;
          }
          if (currentAbort === ac) currentAbort = null;
          if (url) {
            ok = await playElevenLabsNativeFromUrl(url);
          }
        }
      }

      speakingNow = false;
      if (cancelled()) return;
      if (ok) return;
      // ElevenLabs playback genuinely failed (not cancelled) → fallback below
    }

    // If we were cancelled at any point, do NOT play the robotic fallback.
    if (cancelled()) return;

    // Fallback to system TTS (only when not cancelled and ElevenLabs failed)
    await fallbackSpeak(text, lang, tone);
  },
};
