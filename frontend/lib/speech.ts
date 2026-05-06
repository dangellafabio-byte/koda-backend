/**
 * Modular speak() — web uses native Web Speech API directly (more reliable than expo-speech web shim);
 * native uses expo-speech.
 * Future: swap to ElevenLabs / OpenAI TTS by editing only this file.
 */
import * as Speech from "expo-speech";
import { Platform } from "react-native";
import type { Tone } from "./api";

let speakingNow = false;
let webUnlocked = false;
let cachedVoices: SpeechSynthesisVoice[] = [];

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
 * "Unlock" speech engine on first user interaction.
 * Browsers require user gesture before audio playback; calling speechSynthesis
 * once with a tiny silent utterance reliably unlocks subsequent calls.
 */
export async function unlockSpeech(): Promise<void> {
  if (Platform.OS !== "web") return;
  if (webUnlocked) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    await loadWebVoices();
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    u.rate = 1;
    window.speechSynthesis.speak(u);
    webUnlocked = true;
  } catch {}
}

export const SpeechMod = {
  isSpeaking(): boolean {
    return speakingNow;
  },
  stop(): void {
    try {
      if (Platform.OS === "web" && typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      } else {
        Speech.stop();
      }
    } catch {}
    speakingNow = false;
  },
  speak(
    text: string,
    opts: { language?: string; tone?: Tone | null } = {}
  ): Promise<void> {
    return new Promise(async (resolve) => {
      if (!text) {
        resolve();
        return;
      }
      const lang = opts.language || "it-IT";
      const t = opts.tone || "neutral";
      let pitch = 1.0;
      let rate = 1.0;
      switch (t) {
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
          // Direct Web Speech API (more reliable than expo-speech web shim)
          window.speechSynthesis.cancel(); // clear any queue
          if (!cachedVoices.length) {
            await loadWebVoices();
          }
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
          // Safety timeout (Chrome bug: long utterances can stall)
          const timeoutMs = Math.min(60000, Math.max(4000, text.length * 100));
          setTimeout(() => {
            if (speakingNow) {
              try { window.speechSynthesis.cancel(); } catch {}
              finished();
            }
          }, timeoutMs);
          return;
        }
        // Native fallback
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
  },
};
