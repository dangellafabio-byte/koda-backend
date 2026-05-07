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
    // Unlock HTMLAudioElement too (autoplay policies)
    try {
      const a = new Audio();
      a.muted = true;
      await a.play().catch(() => {});
      a.pause();
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

  // Stop web <audio>
  if (currentWebAudio) {
    try {
      currentWebAudio.pause();
      currentWebAudio.src = "";
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
  signal: AbortSignal
): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(`${API_BASE}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: voiceId || undefined }),
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

async function playElevenLabsNative(audioBuf: ArrayBuffer): Promise<boolean> {
  let fileUri: string | null = null;
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
      // before we try to load/play. Without this, the very first TTS after
      // recording can fail silently and we'd fall back to expo-speech.
      await new Promise((r) => setTimeout(r, 60));
    } catch (e) {
      console.warn("[speech] setAudioModeAsync failed", e);
    }

    // Encode bytes to base64
    const b64 = arrayBufferToBase64(audioBuf);
    if (!b64) {
      console.warn("[speech] base64 encoding failed");
      return false;
    }

    // Write MP3 bytes to a temporary file. Audio.Sound playback from a real file URI
    // is far more reliable than a data: URI on both iOS and Android (data URIs often
    // play silently or fail to load).
    const dir = (FileSystem.cacheDirectory || FileSystem.documentDirectory || "") as string;
    if (!dir) {
      console.warn("[speech] no FileSystem dir");
      return false;
    }
    fileUri = `${dir}taccuino_tts_${Date.now()}.mp3`;
    try {
      await FileSystem.writeAsStringAsync(fileUri, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } catch (e) {
      console.warn("[speech] writeAsStringAsync failed", e);
      return false;
    }

    // Create + play
    // CRITICAL iOS FIX: register the playback status callback as the 3rd
    // parameter of createAsync (not via setOnPlaybackStatusUpdate after the
    // fact). With shouldPlay:true + late callback registration, iOS misses
    // every status event (isPlaying, didJustFinish) → Promise never resolves
    // → caller falls back to expo-speech (robotic voice). Known expo-av bug.
    let sound: Audio.Sound;
    let resolvePromise: ((ok: boolean) => void) | null = null;
    let done = false;
    let everPlayed = false;
    const cleanup = async () => {
      try { await (sound as any)?.unloadAsync(); } catch {}
      if (currentSound === sound) currentSound = null;
      if (fileUri) {
        try { await FileSystem.deleteAsync(fileUri, { idempotent: true }); } catch {}
      }
    };
    const onStatus = (status: any) => {
      if (!status.isLoaded) {
        if (!done) {
          done = true;
          const ok = everPlayed;
          cleanup().finally(() => resolvePromise && resolvePromise(ok));
        }
        return;
      }
      if (status.isPlaying || (status.positionMillis ?? 0) > 0) {
        everPlayed = true;
      }
      if (status.didJustFinish) {
        if (!done) {
          done = true;
          cleanup().finally(() => resolvePromise && resolvePromise(true));
        }
      }
    };
    try {
      const created = await Audio.Sound.createAsync(
        { uri: fileUri },
        { shouldPlay: false, volume: 1.0 },
        onStatus,
      );
      sound = created.sound;
    } catch (e) {
      console.warn("[speech] Audio.Sound.createAsync failed", e);
      return false;
    }
    currentSound = sound;

    // Now that the callback is registered, explicitly start playback.
    // This guarantees iOS will fire status updates that we'll actually receive.
    try {
      await sound.playAsync();
    } catch (e) {
      console.warn("[speech] sound.playAsync failed", e);
      try { await sound.unloadAsync(); } catch {}
      currentSound = null;
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
      // Safety timeout
      setTimeout(() => {
        if (!done) {
          done = true;
          cleanup().finally(() => resolve(true));
        }
      }, 60000);
    });
  } catch (e) {
    console.warn("[speech] playElevenLabsNative outer error", e);
    if (fileUri) {
      try { await FileSystem.deleteAsync(fileUri, { idempotent: true }); } catch {}
    }
    return false;
  }
}

async function playElevenLabsWeb(audioBuf: ArrayBuffer): Promise<boolean> {
  try {
    const blob = new Blob([audioBuf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.preload = "auto";
    currentWebAudio = a;

    return await new Promise<boolean>((resolve) => {
      let done = false;
      const cleanup = () => {
        try { URL.revokeObjectURL(url); } catch {}
        if (currentWebAudio === a) currentWebAudio = null;
      };
      a.onended = () => {
        if (!done) {
          done = true;
          cleanup();
          resolve(true);
        }
      };
      a.onerror = () => {
        if (!done) {
          done = true;
          cleanup();
          resolve(false);
        }
      };
      a.onpause = () => {
        // User-triggered pause (barge-in) is treated as end
        if (!done && a.currentTime > 0 && !a.ended) {
          done = true;
          cleanup();
          resolve(true);
        }
      };
      a.play().catch(() => {
        if (!done) {
          done = true;
          cleanup();
          resolve(false);
        }
      });
    });
  } catch {
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
      const buf = await fetchTTSBytes(text, opts.voiceId ?? defaultVoiceId, ac.signal);
      if (cancelled()) {
        // User started a new speak()/stop() — bail silently, no fallback.
        speakingNow = false;
        return;
      }
      // Clear our abort handle if it's still ours (another call might have replaced it)
      if (currentAbort === ac) currentAbort = null;

      if (buf && buf.byteLength > 0) {
        let ok = false;
        if (Platform.OS === "web") {
          ok = await playElevenLabsWeb(buf);
        } else {
          ok = await playElevenLabsNative(buf);
        }
        speakingNow = false;
        if (cancelled()) return;
        if (ok) return;
        // ElevenLabs playback genuinely failed (not cancelled) → fallback below
      } else {
        speakingNow = false;
        // fetch returned empty — could be a real failure, fall through to fallback
      }
    }

    // If we were cancelled at any point, do NOT play the robotic fallback.
    if (cancelled()) return;

    // Fallback to system TTS (only when not cancelled and ElevenLabs failed)
    await fallbackSpeak(text, lang, tone);
  },
};
