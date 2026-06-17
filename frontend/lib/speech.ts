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
import * as FileSystem from "expo-file-system/legacy";
import type { Tone } from "./api";
import { API_BASE, BACKEND } from "./api";
import { startReactiveWaveform, stopReactiveWaveform } from "./audioReactivity";

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
  // === ORB REATTIVO (2026-06 #3) ===
  // Fermiamo sempre il driver waveform appena interrompiamo il playback.
  try { stopReactiveWaveform(); } catch {}

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
  // === FIX 2026-05-25 (mirato SOLO al playback) ===
  // Su iOS, dopo che il microfono ha registrato (categoria PlayAndRecord),
  // il semplice setAudioModeAsync({allowsRecording:false}) NON forza
  // sempre la transizione a Playback puro. iOS mantiene la categoria
  // PlayAndRecord che instrada l'audio attraverso l'earpiece (volume
  // bassissimo, sembra "muto"). Per forzare iOS ad applicare la nuova
  // categoria serve un ciclo deactivate → configure → reactivate.
  //
  // Lo applichiamo SOLO qui (playback path), NON nel recording
  // (voice.ts), perché lì rompe l'attivazione del microfono. Il fix
  // simmetrico recording-side è stato rollbackato il 2026-05-24.
  try {
    await setIsAudioActiveAsync(false);
  } catch {}
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
  } catch {}

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

// ============================================================
// FAST CONVERSE — sub-2s end-to-end latency client.
// Calls POST /api/converse-fast/start, then long-polls
// /api/converse-fast/poll/{sid} for sentence tokens. Each token's
// MP3 is played sequentially via the existing static-file path
// (/api/tts/audio/{token}.mp3) which has Content-Length + Range
// headers — fully compatible with iOS AVPlayer.
//
// Time-to-first-audio: ~1.0-1.7s server-side + ~150-300ms network.
// ============================================================

export type FastConverseMeta = {
  reply: string;
  voice_text?: string | null;
  tone?: Tone | null;
  actions?: any[];
};

export type FastConverseResult = {
  ok: boolean;
  meta?: FastConverseMeta;
  error?: string;
};

// ============================================================
// FILLER POOL (giugno 2026 v3 — sostenibile, mai silenzio)
// Pre-caricato all'avvio dell'app. Quando l'utente preme l'orb e
// finisce di parlare, il client può accodare 1 o più filler dal pool
// in loop random finché non arriva la vera prima frase.
// ============================================================
let _FILLER_POOL: string[] = [];
let _FILLER_POOL_VOICE: string | null = null;

/** Precarica il pool di filler audio per la voce data. Chiamare all'avvio
 *  app (in index.tsx dopo aver risolto il profilo) e quando l'utente
 *  cambia voce in Impostazioni. */
export async function preloadFillerPool(voiceId: string, apiBase: string): Promise<void> {
  if (_FILLER_POOL_VOICE === voiceId && _FILLER_POOL.length > 0) return;
  try {
    const resp = await fetch(
      `${apiBase.replace(/\/$/, "")}/api/fillers?voice_id=${encodeURIComponent(voiceId)}`,
      { method: "GET" }
    );
    if (!resp.ok) return;
    const data = await resp.json();
    if (Array.isArray(data?.tokens) && data.tokens.length > 0) {
      _FILLER_POOL = data.tokens.filter((t: any) => typeof t === "string" && t.length > 0);
      _FILLER_POOL_VOICE = voiceId;
      console.log(`[FillerPool] preloaded ${_FILLER_POOL.length} tokens for voice ${voiceId}`);
    }
  } catch (e) {
    console.warn("[FillerPool] preload failed:", e);
  }
}

/** Random pick dal pool, escludendo (se possibile) un token già usato. */
function pickRandomFiller(excludeToken?: string | null): string | null {
  if (_FILLER_POOL.length === 0) return null;
  const candidates = excludeToken
    ? _FILLER_POOL.filter((t) => t !== excludeToken)
    : _FILLER_POOL;
  const arr = candidates.length > 0 ? candidates : _FILLER_POOL;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function _playStaticTokenSequential(
  token: string,
  onAudioStart?: () => void,
  signal?: AbortSignal
): Promise<boolean> {
  const url = `${API_BASE}/tts/audio/${token}.mp3`;
  if (signal?.aborted) return false;
  if (Platform.OS === "web") {
    try {
      const r = await fetch(url, { signal });
      if (!r.ok) return false;
      const buf = await r.arrayBuffer();
      if (signal?.aborted) return false;
      try { onAudioStart?.(); } catch {}
      return await playElevenLabsWeb(buf);
    } catch {
      return false;
    }
  }
  return await playElevenLabsNativeFromUrl(url, onAudioStart);
}

export async function fastConverse(
  text: string,
  opts: {
    ephemeral?: boolean;
    audioDurationMs?: number;
    onAudioStart?: () => void;
    onMeta?: (meta: FastConverseMeta) => void;
    timeoutMs?: number;  // overall hard timeout (default 45s)
  } = {}
): Promise<FastConverseResult> {
  const timeoutMs = opts.timeoutMs ?? 45000;

  // Stop any in-flight playback so we don't overlap.
  stopAllPlayback();
  speakingNow = true;

  // Re-arm iOS audio session (idempotent, fast).
  await prewarmAudio();

  const ac = new AbortController();
  currentAbort = ac;

  // Hard timeout: if the whole flow exceeds timeoutMs, abort.
  const hardTimer = setTimeout(() => {
    try { ac.abort(); } catch {}
  }, timeoutMs);

  try {
    // 1) Start the session.
    const startResp = await fetch(`${API_BASE}/converse-fast/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ephemeral: !!opts.ephemeral,
        audio_duration_ms: opts.audioDurationMs,
      }),
      signal: ac.signal,
    });
    if (!startResp.ok) {
      const errText = await startResp.text().catch(() => "");
      return { ok: false, error: `start failed: ${startResp.status} ${errText.slice(0, 200)}` };
    }
    const startData = await startResp.json();
    const sid = startData?.session_id;
    if (!sid || typeof sid !== "string") {
      return { ok: false, error: "no session_id from server" };
    }
    // === FILLER POOL (giugno 2026 v3 — sostenibile, mai silenzio) ===
    // Strategia: il backend nel response del POST ci consegna UN filler_token
    // (random, già pre-generato server-side). Inoltre, all'avvio dell'app
    // abbiamo precaricato in memoria TUTTI i token filler (vedi
    // preloadFillerPool). Usiamo il filler del response come PRIMO della
    // coda (è random già selezionato dal server). Più sotto, se la prima
    // vera frase tarda, accodiamo altri filler dal pool locale per coprire
    // il gap → mai più silenzio.
    const fillerToken: string | null = typeof startData?.filler_token === "string" ? startData.filler_token : null;

    // 2) Long-poll loop. Maintains a queue of pending tokens to play.
    let cursor = 0;
    let meta: FastConverseMeta | undefined;
    let pollingDone = false;
    let firstAudioFired = false;
    let pollError: string | null = null;

    const tokenQueue: { i: number; token: string; text: string; waveform?: number[] | null; window_ms?: number; isFiller?: boolean }[] = [];
    let resolveTokenWait: (() => void) | null = null;

    // Se il backend ci ha dato un filler_token, lo accodiamo SUBITO (prima
    // del polling) così il player lo suona immediatamente — l'utente sente
    // Koda "rispondere" entro 200-400ms invece di 2-3s di silenzio.
    if (fillerToken && !opts.ephemeral) {
      tokenQueue.push({
        i: -1,
        token: fillerToken,
        text: "",
        waveform: null,
        window_ms: 60,
        isFiller: true,
      });
    }

    const waitForToken = () =>
      new Promise<void>((resolve) => {
        if (tokenQueue.length > 0 || pollingDone || pollError) {
          resolve();
          return;
        }
        resolveTokenWait = () => {
          resolveTokenWait = null;
          resolve();
        };
      });
    const notifyTokenWait = () => {
      if (resolveTokenWait) resolveTokenWait();
    };

    // === BRIDGE FILLER DISABILITATO (giugno 2026 v4) ===
    // Il bridge filler concatenato (più filler in loop) accumulava in coda
    // creando attese di 20+ secondi quando il LLM tardava un po'. Tornato al
    // comportamento semplice: SOLO il filler iniziale dal server, poi attendi
    // la prima frase reale. Niente concatenazione automatica.
    const bridgeInterval: any = null;
    let firstRealSentence = false;

    // Pollster — runs in parallel with the audio player.
    const pollster = (async () => {
      while (!ac.signal.aborted && !pollingDone) {
        try {
          const r = await fetch(
            `${API_BASE}/converse-fast/poll/${sid}?since=${cursor}&timeout=4`,
            { signal: ac.signal }
          );
          if (!r.ok) {
            pollError = `poll ${r.status}`;
            pollingDone = true;
            notifyTokenWait();
            break;
          }
          const data = await r.json();
          const evts: any[] = data?.events || [];
          cursor = typeof data?.next === "number" ? data.next : cursor + evts.length;
          for (const ev of evts) {
            if (ev?.type === "sentence" && ev.token) {
              // === 2026-06 #3: passo waveform + window_ms al consumer
              //     così l'orb può pulsare in sincrono con sillabe reali. ===
              tokenQueue.push({
                i: ev.i || 0,
                token: ev.token,
                text: ev.text || "",
                waveform: Array.isArray(ev.waveform) ? ev.waveform : null,
                window_ms: typeof ev.window_ms === "number" ? ev.window_ms : 60,
              });
              // Prima frase REALE arrivata → stop bridge filler.
              firstRealSentence = true;
              try { clearInterval(bridgeInterval); } catch {}
              notifyTokenWait();
            } else if (ev?.type === "meta") {
              meta = {
                reply: ev.reply || "",
                voice_text: ev.voice_text ?? null,
                tone: (ev.tone as Tone) ?? null,
                actions: Array.isArray(ev.actions) ? ev.actions : [],
              };
              try { opts.onMeta?.(meta); } catch {}
            } else if (ev?.type === "error") {
              pollError = String(ev.message || "server error");
              pollingDone = true;
              notifyTokenWait();
              break;
            }
          }
          if (data?.done) {
            pollingDone = true;
            notifyTokenWait();
            break;
          }
        } catch (e: any) {
          if (ac.signal.aborted) {
            pollingDone = true;
            notifyTokenWait();
            break;
          }
          // Transient network error — short backoff then retry.
          await new Promise((res) => setTimeout(res, 250));
        }
      }
    })();

    // Player — consumes tokenQueue sequentially.
    const player = (async () => {
      while (!ac.signal.aborted) {
        if (tokenQueue.length === 0) {
          if (pollingDone || pollError) break;
          await waitForToken();
          continue;
        }
        const { token, waveform, window_ms } = tokenQueue.shift()!;
        const fireStart = !firstAudioFired
          ? () => {
              firstAudioFired = true;
              try { opts.onAudioStart?.(); } catch {}
              // === ORB REATTIVO (2026-06 #3) ===
              // Avvio del driver waveform sincronizzato con la prima frase.
              try {
                if (waveform && waveform.length > 0) {
                  startReactiveWaveform(waveform, window_ms || 60);
                }
              } catch {}
            }
          : () => {
              // Per le frasi successive (non la prima), aggiorniamo il
              // driver in modo che continui a seguire la cadenza nuova.
              try {
                if (waveform && waveform.length > 0) {
                  startReactiveWaveform(waveform, window_ms || 60);
                }
              } catch {}
            };
        try {
          await _playStaticTokenSequential(token, fireStart, ac.signal);
        } catch (e) {
          console.warn("[fastConverse] token playback failed:", e);
        }
        if (ac.signal.aborted) break;
      }
    })();

    await Promise.all([pollster, player]);

    if (ac.signal.aborted) {
      return { ok: false, error: "aborted" };
    }
    if (pollError) {
      return { ok: false, error: pollError, meta };
    }
    return { ok: true, meta };
  } catch (e: any) {
    if (ac.signal.aborted) return { ok: false, error: "aborted" };
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(hardTimer);
    try { clearInterval(bridgeInterval); } catch {}
    if (currentAbort === ac) currentAbort = null;
    speakingNow = false;
  }
}

// ============================================================
// FASE 1 — STREAMING via WebSocket (giugno 2026)
// ============================================================
// fastConverseWS — versione WebSocket di fastConverse. Latenza target
// ~30-50% inferiore rispetto al long-polling: niente ciclo Mongo-poll
// (~100-300ms per evento), niente secondo HTTP roundtrip per scaricare
// /api/tts/audio/{token}.mp3 (~150-300ms per frase). I byte audio
// arrivano direttamente nel binary frame del WS, vengono scritti in un
// file temporaneo locale e suonati immediatamente.
//
// Fallback automatico: se il WS fallisce (connessione caduta, errore,
// timeout), fastConverseWS ritorna { ok:false, error:"ws-failed", ... }
// e il chiamante può ripiegare su fastConverse (HTTP poll) senza
// perdere il messaggio.
// ============================================================

function _buildWsUrl(): string {
  // BACKEND è del tipo https://...railway.app o http://localhost:8001
  // Conversione robusta: http→ws, https→wss.
  // Se window.location ha protocollo "https:", la regex copre già il caso.
  const base = BACKEND || "";
  if (base.startsWith("https://")) return "wss://" + base.slice("https://".length);
  if (base.startsWith("http://")) return "ws://" + base.slice("http://".length);
  // Web preview senza prefisso: si appoggia all'origin corrente.
  if (typeof window !== "undefined" && window.location) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  // Ultimo fallback insicuro ma operativo per i test locali.
  return "ws://localhost:8001";
}

function _bytesToBase64(bytes: Uint8Array): string {
  // Encode binario → base64 senza dipendere da Buffer (non incluso in RN).
  // Per file MP3 piccoli (<200KB) è velocissimo (~5-15ms).
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  // btoa è globale su web; su RN moderno (Hermes) è disponibile via polyfill.
  if (typeof btoa === "function") return btoa(bin);
  // Fallback manuale (RN Hermes < 0.74 senza polyfill).
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  while (i < bin.length) {
    const a = bin.charCodeAt(i++);
    const b = i < bin.length ? bin.charCodeAt(i++) : -1;
    const c = i < bin.length ? bin.charCodeAt(i++) : -1;
    const b1 = a >> 2;
    const b2 = ((a & 3) << 4) | (b >= 0 ? b >> 4 : 0);
    const b3 = b >= 0 ? (((b & 15) << 2) | (c >= 0 ? c >> 6 : 0)) : 64;
    const b4 = c >= 0 ? c & 63 : 64;
    out += chars[b1] + chars[b2] + (b3 === 64 ? "=" : chars[b3]) + (b4 === 64 ? "=" : chars[b4]);
  }
  return out;
}

async function _writeMp3ToFile(bytes: Uint8Array, idx: number): Promise<string | null> {
  // Su web preferiamo un blob URL (vedi _playMp3BytesWeb più sotto).
  if (Platform.OS === "web") return null;
  try {
    const dir = (FileSystem as any).cacheDirectory;
    if (!dir) return null;
    const path = `${dir}koda_ws_${Date.now()}_${idx}.mp3`;
    const b64 = _bytesToBase64(bytes);
    await (FileSystem as any).writeAsStringAsync(path, b64, {
      encoding: (FileSystem as any).EncodingType?.Base64 ?? "base64",
    });
    return path;
  } catch (e) {
    console.warn("[ws] writeMp3ToFile failed:", e);
    return null;
  }
}

async function _playMp3BytesWeb(bytes: Uint8Array, onStart?: () => void): Promise<boolean> {
  try {
    // Copia sicura in un nuovo ArrayBuffer (evita problemi di tipo
    // ArrayBufferLike vs ArrayBuffer su strict TS).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    try { onStart?.(); } catch {}
    return await playElevenLabsWeb(ab);
  } catch (e) {
    console.warn("[ws] playMp3BytesWeb failed:", e);
    return false;
  }
}

export async function fastConverseWS(
  text: string,
  opts: {
    ephemeral?: boolean;
    audioDurationMs?: number;
    onAudioStart?: () => void;
    onMeta?: (meta: FastConverseMeta) => void;
    timeoutMs?: number;
  } = {}
): Promise<FastConverseResult> {
  const timeoutMs = opts.timeoutMs ?? 45000;

  stopAllPlayback();
  speakingNow = true;
  await prewarmAudio();

  const ac = new AbortController();
  currentAbort = ac;

  const wsUrl = `${_buildWsUrl()}/api/converse-ws`;
  let ws: WebSocket | null = null;
  let pendingSentence: any | null = null; // header in attesa del binary frame
  type SentenceItem = {
    i: number;
    bytes: Uint8Array;
    waveform: number[] | null;
    window_ms: number;
  };
  const sentenceQueue: SentenceItem[] = [];
  let resolveTokenWait: (() => void) | null = null;
  let metaCaptured: FastConverseMeta | undefined;
  let firstAudioFired = false;
  let pollingDone = false;
  let pollError: string | null = null;

  const notify = () => { if (resolveTokenWait) { resolveTokenWait(); resolveTokenWait = null; } };
  const waitForToken = () => new Promise<void>((resolve) => {
    if (sentenceQueue.length > 0 || pollingDone || pollError) { resolve(); return; }
    resolveTokenWait = resolve;
  });

  const hardTimer = setTimeout(() => {
    try { ac.abort(); } catch {}
    try { ws?.close(); } catch {}
  }, timeoutMs);

  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
  } catch (e) {
    clearTimeout(hardTimer);
    speakingNow = false;
    return { ok: false, error: `ws-construct-failed: ${String(e)}` };
  }

  ws.onopen = () => {
    try {
      ws?.send(JSON.stringify({
        text,
        ephemeral: !!opts.ephemeral,
        audio_duration_ms: opts.audioDurationMs,
      }));
    } catch (e) {
      pollError = `ws-send-failed: ${String(e)}`;
      pollingDone = true;
      notify();
    }
  };

  ws.onmessage = (ev: MessageEvent) => {
    try {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg?.type === "sentence") {
          // Aspetta il binary frame successivo per i bytes.
          pendingSentence = msg;
        } else if (msg?.type === "meta") {
          metaCaptured = {
            reply: msg.reply || "",
            voice_text: msg.voice_text ?? null,
            tone: (msg.tone as Tone) ?? null,
            actions: Array.isArray(msg.actions) ? msg.actions : [],
          };
          try { opts.onMeta?.(metaCaptured); } catch {}
        } else if (msg?.type === "error") {
          pollError = String(msg.message || "ws-error");
          pollingDone = true;
          notify();
        } else if (msg?.type === "done") {
          pollingDone = true;
          notify();
        } else if (msg?.type === "session") {
          // ignored: utile per debug
        }
      } else {
        // Binary frame → bytes audio della frase precedente.
        const u8 = ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new Uint8Array((ev.data as any));
        if (pendingSentence) {
          sentenceQueue.push({
            i: pendingSentence.i || 0,
            bytes: u8,
            waveform: Array.isArray(pendingSentence.waveform) ? pendingSentence.waveform : null,
            window_ms: typeof pendingSentence.window_ms === "number" ? pendingSentence.window_ms : 60,
          });
          pendingSentence = null;
          notify();
        } else {
          console.warn("[ws] binary frame without header — discarded");
        }
      }
    } catch (e) {
      console.warn("[ws] onmessage parse error:", e);
    }
  };

  ws.onerror = (ev: Event) => {
    console.warn("[ws] onerror:", ev);
    if (!pollError) pollError = "ws-network-error";
    pollingDone = true;
    notify();
  };

  ws.onclose = () => {
    pollingDone = true;
    notify();
  };

  // Player loop: consume bytes → write to file (native) → play.
  try {
    while (!ac.signal.aborted) {
      if (sentenceQueue.length === 0) {
        if (pollingDone || pollError) break;
        await waitForToken();
        continue;
      }
      const item = sentenceQueue.shift()!;
      const fireStart = () => {
        if (!firstAudioFired) {
          firstAudioFired = true;
          try { opts.onAudioStart?.(); } catch {}
        }
        try {
          if (item.waveform && item.waveform.length > 0) {
            startReactiveWaveform(item.waveform, item.window_ms || 60);
          }
        } catch {}
      };
      try {
        if (Platform.OS === "web") {
          await _playMp3BytesWeb(item.bytes, fireStart);
        } else {
          const path = await _writeMp3ToFile(item.bytes, item.i);
          if (!path) {
            console.warn("[ws] file write returned null — skipping playback");
            continue;
          }
          await playElevenLabsNativeFromUrl(path, fireStart);
        }
      } catch (e) {
        console.warn("[ws] sentence playback failed:", e);
      }
      if (ac.signal.aborted) break;
    }
  } finally {
    try { ws?.close(); } catch {}
    clearTimeout(hardTimer);
    if (currentAbort === ac) currentAbort = null;
    speakingNow = false;
  }

  if (ac.signal.aborted) return { ok: false, error: "aborted" };
  if (pollError) return { ok: false, error: pollError, meta: metaCaptured };
  return { ok: true, meta: metaCaptured };
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
  fastConverse,
  fastConverseWS,
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
