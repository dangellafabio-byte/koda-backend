/**
 * Modular speak() — currently uses expo-speech (system voice).
 * Future: swap implementation to ElevenLabs / OpenAI TTS by replacing this module.
 */
import * as Speech from "expo-speech";
import { Platform } from "react-native";
import type { Tone } from "./api";

let speakingNow = false;

export const SpeechMod = {
  isSpeaking(): boolean {
    return speakingNow;
  },
  stop(): void {
    try {
      Speech.stop();
    } catch {}
    speakingNow = false;
  },
  speak(
    text: string,
    opts: { language?: string; tone?: Tone | null } = {}
  ): Promise<void> {
    return new Promise((resolve) => {
      try {
        Speech.stop();
      } catch {}
      const lang = opts.language || "it-IT";
      // Map tone to pitch/rate
      const t = opts.tone || "neutral";
      let pitch = 1.0;
      let rate = 1.0;
      switch (t) {
        case "calm":
          pitch = 0.95;
          rate = 0.92;
          break;
        case "warm":
          pitch = 1.0;
          rate = 0.95;
          break;
        case "energetic":
          pitch = 1.1;
          rate = 1.05;
          break;
        case "concerned":
          pitch = 0.9;
          rate = 0.95;
          break;
        case "urgent":
          pitch = 1.15;
          rate = 1.1;
          break;
        default:
          pitch = 1.0;
          rate = 1.0;
      }

      // expo-speech doesn't support pitch on web; that's fine
      const finished = () => {
        speakingNow = false;
        resolve();
      };
      try {
        speakingNow = true;
        Speech.speak(text, {
          language: lang === "it" ? "it-IT" : lang,
          pitch,
          rate,
          onDone: finished,
          onStopped: finished,
          onError: finished,
        });
        // Web: trigger a safety timeout (max 30s)
        if (Platform.OS === "web") {
          setTimeout(finished, 30000);
        }
      } catch {
        finished();
      }
    });
  },
};
