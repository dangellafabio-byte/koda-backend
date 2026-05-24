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
  setIsAudioActiveAsync,
} from "expo-audio";
import { Platform } from "react-native";
import type { Tone } from "./api";
import { API_BASE } from "./api";

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

/**
 * Pre-warm iOS/Android audio session at app boot.
 *
 * iOS issue: the FIRST call to `setAudioModeAsync(playback)` + `createAudioPlayer`
 * + `.play()` after app launch has a ~1-3s warm-up window during which AVPlayer
 * is silently buffering even though playbackStatus says "playing". The user hears
 * NOTHING for the first TTS, then everything works from step 2 onwards.
 *
 * Additional iOS issue: if the audio session is initialized at boot but then
 * NOTHING uses it for several seconds (e.g. during a long splash screen),
 * iOS may "demote" the session and the next playback attempt will again be
 * silent. So this function is intentionally NOT one-shot — it can be called
 * multiple times to "re-arm" the session, and is idempotent and safe.
 *
 * Errors are swallowed.
 */
export async function prewarmAudio(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch (e) {
    console.warn("[speech] prewarmAudio: setAudioModeAsync failed", e);
  }
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
  // === FIX RESOURCE LEAK 2026-05-24 ===
  // Prima azzeravamo `currentPlayer = null` PRIMA di chiamare p.remove(),
  // creando una race condition: se un altro thread stava già chiamando
  // cleanup() in playElevenLabsNativeFromUrl, il check `currentPlayer ===
  // player` falliva → il player.remove() veniva saltato → AVPlayer
  // SharedObject non rilasciato → audio session iOS continuava a tenere
  // risorse occupate → dopo 3-5 turni di conversazione, AVPlayer non
  // riusciva più ad avviare nuovi playback (fallimento silenzioso).
  // Self-heal dopo 2-5 min = iOS GC riprende le risorse.
  // Soluzione: nullare currentPlayer DOPO p.remove() così che la
  // condizione di cleanup nei caller resti coerente.
  if (currentPlayer) {
    const p = currentPlayer;
    try {
      p.pause?.();
    } catch {}
    // `remove()` releases the SharedObject and tears down the AVPlayer.
    try {
      p.remove?.();
    } catch {}
    currentPlayer = null;
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

async function playElevenLabsNativeFromUrl(audioUrl: string, onAudioStart?: () => void): Promise<boolean> {
  // === FIX 2026-05-24 (root cause "no audio heard, AVPlayer fails silently") ===
  // Su iOS la transizione da PlayAndRecord → Playback richiede di
  // DEATTIVARE esplicitamente la sessione audio in mezzo. Senza questo
  // ciclo deactivate→configure→reactivate, la categoria AVAudioSession
  // resta in "PlayAndRecord" anche dopo setAudioModeAsync({allowsRecording:
  // false}), perché iOS rispetta la configurazione solo se la sessione è
  // inattiva al momento della modifica. Risultato: AVPlayer prova a
  // riprodurre ma o passa per l'earpiece (audio "muto") o stalla
  // silenziosamente. Sintomo classico: l'utente vede ciclamino per <1s
  // poi torna idle, nessun suono, nessun errore. Si "auto-ripristina"
  // dopo 2-5 minuti perché iOS internamente disattiva la sessione orfana
  // → al turno successivo la nuova configurazione viene applicata.
  //
  // Sequenza corretta:
  //   1. setIsAudioActiveAsync(false) → forza iOS a rilasciare la sessione corrente
  //   2. setAudioModeAsync(playback)  → configura la nuova modalità
  //   3. setIsAudioActiveAsync(true)  → riattiva con la modalità nuova applicata
  try {
    await setIsAudioActiveAsync(false);
  } catch (e) {
    // Non fatale: alcune versioni iOS non richiedono la deattivazione esplicita.
  }
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
  try {
    await setIsAudioActiveAsync(true);
  } catch (e) {
    // Non fatale: setAudioModeAsync di solito riattiva da solo.
  }

  return await new Promise<boolean>((resolve) => {
    let done = false;
    let everPlayed = false;
    let firstSoundFired = false;
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
      // === FIX RESOURCE LEAK 2026-05-24 ===
      // Prima: `if (player && currentPlayer === player) currentPlayer = null;`
      // — la condizione `player &&` falliva quando il cleanup veniva chiamato
      // dopo che player era già stato nullato altrove, lasciando
      // `currentPlayer` con un riferimento orfano che bloccava le successive
      // creazioni di AudioPlayer. Ora controlliamo solo l'identità con
      // currentPlayer e SEMPRE nulliamo se matcha, anche se `player` ref
      // locale è già null.
      if (currentPlayer === player) {
        currentPlayer = null;
      }
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
          if (pos > lastPositionSec) {
            lastPositionSec = pos;
            lastProgressAt = Date.now();
          }
          if (status.playing || pos > 0) {
            everPlayed = true;
            // === Fire onAudioStart il PRIMO frame in cui sentiamo davvero
            // audio. Il chiamante può usarlo per ritardare lo switch della
            // UI a "speaking" → la vibrazione dell'eclissi parte ESATTAMENTE
            // quando l'utente sente la prima sillaba, non quando la
            // richiesta di rete è partita (che ha ~300-800ms di TTFB).
            if (!firstSoundFired) {
              firstSoundFired = true;
              try { onAudioStart?.(); } catch (e) { console.warn("[speech] onAudioStart cb threw:", e); }
            }
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
   * @param url       Audio URL
   * @param onAudioStart  Callback chiamato ESATTAMENTE quando l'audio
   *                      comincia davvero a suonare (currentTime>0). Utile
   *                      per ritardare la transizione UI "speaking" fino a
   *                      quando l'utente sente la prima sillaba — così
   *                      l'eclissi NON vibra mentre è ancora silenziosa
   *                      (durante i 300-800ms di TTFB di rete).
   *
   * Returns true on successful playback to end, false on error/cancel.
   */
  async playFromUrl(url: string, onAudioStart?: () => void): Promise<boolean> {
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
          // Web non ha latenza di rete dopo il fetch completo —
          // l'audio inizia praticamente subito. Spariamo il cb subito.
          try { onAudioStart?.(); } catch {}
          const ok = await playElevenLabsWeb(buf);
          speakingNow = false;
          return ok;
        } catch {
          speakingNow = false;
          return false;
        }
      }
      // Native: hand URL to AVPlayer-backed expo-audio AudioPlayer.
      const ok = await playElevenLabsNativeFromUrl(url, onAudioStart);
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

    // Ri-arma la audio session iOS prima di OGNI speak. È idempotent e
    // velocissimo, ma copre il caso in cui iOS ha "demoted" la session
    // durante un periodo di inattività (es. dopo lo splash di 10s).
    // Senza questo, il primo speak post-splash è muto.
    await prewarmAudio();

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
        // Native (iOS/Android) — PREPARE-FIRST (changed from streaming-first).
        //
        // Why: iOS AVPlayer (used by expo-audio) refuses to start progressive
        // playback on chunked-transfer MP3 streams that lack Content-Length and
        // Accept-Ranges headers. The /api/tts/stream endpoint serves chunked MP3
        // without those headers → AVPlayer silently stalls → SpeechMod falls back
        // to expo-speech robotic voice. Bug observed on iPhone 13 Pro, iOS Ad-Hoc
        // build, May 2026.
        //
        // /api/tts/prepare → token → /api/tts/audio/{token}.mp3 is served as a
        // static file with proper Content-Length and Accept-Ranges, which AVPlayer
        // streams cleanly. The trade-off is ~3-5s extra latency (server waits for
        // ElevenLabs to finish generating the full MP3 before returning the token)
        // but the user gets the REAL Matilda voice instead of the iOS robotic
        // fallback — a much better UX.
        //
        // Streaming endpoint is kept as a secondary fallback only.
        const url = await prepareTTSUrl(text, voiceArg, tone, ac.signal);
        if (cancelled()) {
          speakingNow = false;
          return;
        }
        if (url) {
          ok = await playElevenLabsNativeFromUrl(url);
        }
        if (currentAbort === ac) currentAbort = null;
        // Fallback: streaming (might work on Android or future iOS fixes).
        if (!ok && !cancelled()) {
          console.warn("[speech] prepared TTS failed, falling back to /tts/stream");
          const streamUrl = buildStreamUrl(text, voiceArg, tone);
          ok = await playElevenLabsNativeFromUrl(streamUrl);
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
