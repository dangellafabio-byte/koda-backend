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
    // === FIX 2026-06-27 v18 (Android Xiaomi: TTS continuava dopo stop) ===
    // Su Android, `expo-audio.pause()` non sempre interrompe immediatamente
    // il playback: il buffer audio interno può continuare a riprodurre per
    // alcuni secondi anche dopo pause(), e remove() a volte tarda. Risultato:
    // l'utente tappa l'orb per fermare Koda, la UI passa a "idle" ma la voce
    // continua. Fix aggressivo: muta il volume e fa seekTo(0) PRIMA di
    // remove() — combo che forza Android a smettere subito di emettere audio.
    if (Platform.OS === "android") {
      try { p.volume = 0; } catch {}
      try { p.seekTo?.(0); } catch {}
    }
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

/** === FIX 2026-06-26 v15: prewarm audio session per ridurre TTFB ===
 *  Nei log v14 abbiamo osservato che la prima frase TTS di ogni risposta
 *  paga ~670ms sulla chiamata `setIsAudioActiveAsync(false)` (transizione
 *  recording→playback su iOS). Lanciando questo ciclo IN PARALLELO con la
 *  pipeline LLM/TTS del backend (che richiede 2-3s), eliminiamo quei 670ms
 *  dal time-to-first-audio percepito dall'utente.
 *
 *  Chiamato da `voiceStreamConverse.onFinal` quando arriva `stt_final` —
 *  l'utente ha finito di parlare, sappiamo che servirà il playback.
 *  Il risultato viene memorizzato in `prewarmPromise` e CONSUMATO dal
 *  prossimo ciclo audio in `playElevenLabsNativeFromUrl`. */
let prewarmPromise: Promise<void> | null = null;
function prewarmPlaybackSession(): Promise<void> {
  if (prewarmPromise) return prewarmPromise;
  const tStart = Date.now();
  prewarmPromise = (async () => {
    try {
      await setIsAudioActiveAsync(false);
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      await setIsAudioActiveAsync(true);
      console.log(`[KODA_TTS_PREWARM] completed in ${Date.now() - tStart}ms`);
    } catch (e) {
      console.log(`[KODA_TTS_PREWARM] failed (non-blocking):`, e);
    }
  })();
  return prewarmPromise;
}

/** Consuma il prewarm se in volo, altrimenti restituisce null.
 *  Il prossimo turno dovrà far ripartire il prewarm da zero. */
function consumePrewarm(): Promise<void> | null {
  const p = prewarmPromise;
  prewarmPromise = null;
  return p;
}

async function playElevenLabsNativeFromUrl(
  audioUrl: string,
  onAudioStart?: () => void,
  playOpts?: { skipAudioSessionCycle?: boolean; tailBufferMs?: number }
): Promise<boolean> {
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
  //
  // === FIX 2026-06-25 v10 (post-Build #9 "mangia le parole") ===
  // PROBLEMA: il ciclo deactivate→reactivate veniva eseguito per OGNI
  // frase TTS dello stream. Tra frase N e frase N+1, setIsAudioActiveAsync(false)
  // abbatteva la audio session iOS, troncando ~80-150ms di buffer hardware
  // residuo della frase N (l'utente sentiva "mangia le parole / frasi a metà").
  // SOLUZIONE: il chiamante (es. voiceStreamConverse player loop) può ora
  // passare `skipAudioSessionCycle:true` per le frasi SUCCESSIVE alla prima
  // dello stream, dopo aver già eseguito il ciclo una sola volta out-of-loop.
  // Inoltre `tailBufferMs` aggiunge un piccolo grace period dopo didJustFinish
  // per dare al buffer hardware tempo di drenare prima della frase successiva.
  // === FIX 2026-06-26 v13: timeout wrapper anti-hang ===
  // Su iOS, se l'AVPlayer della frase precedente è ancora in fase di
  // teardown async, le chiamate setIsAudioActiveAsync(false) /
  // setAudioModeAsync possono HANGARE indefinitamente (osservato: 38s di
  // freeze in "speaking" sul Turn 3 della Build #12, fra sent #1 e sent #2).
  // Mettiamo un timeout duro: se la chiamata non risponde in 1.5s,
  // proseguiamo lo stesso. iOS si auto-riprende al prossimo ciclo.
  const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const tStart = Date.now();
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        console.log(`[KODA_TTS_PLAY] cycle_step=${label} TIMEOUT after ${ms}ms`);
        resolve();
      }, ms);
      p.then(() => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        console.log(`[KODA_TTS_PLAY] cycle_step=${label} ok ms=${Date.now() - tStart}`);
        resolve();
      }).catch((e) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        console.log(`[KODA_TTS_PLAY] cycle_step=${label} ERROR ms=${Date.now() - tStart} err=${String(e?.message || e).slice(0, 60)}`);
        resolve();
      });
    });
  };

  const skipCycle = playOpts?.skipAudioSessionCycle === true;
  const tailBufferMs = playOpts?.tailBufferMs ?? 0;
  if (!skipCycle) {
    // === FIX 2026-06-26 v15: usa prewarm se disponibile ===
    // Se onFinal ha già lanciato prewarmPlaybackSession() in parallelo
    // con la pipeline LLM/TTS, qui ne aspettiamo solo il completamento
    // (di solito ZERO attesa perché LLM+TTS impiegano 2-3s, più che
    // sufficienti per i 670ms del setIsActive(false)). Risparmio
    // garantito su TTFB della prima frase.
    const prew = consumePrewarm();
    if (prew) {
      const tWait = Date.now();
      await prew;
      console.log(`[KODA_TTS_PLAY] cycle_step=prewarm_consumed ms=${Date.now() - tWait}`);
    } else {
      await withTimeout(setIsAudioActiveAsync(false), 1500, "setIsActive(false)");
      await withTimeout(
        setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          interruptionMode: "duckOthers",
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
        }),
        1500,
        "setAudioMode(playback)"
      );
      await withTimeout(setIsAudioActiveAsync(true), 1500, "setIsActive(true)");
    }
  }

  return await new Promise<boolean>((resolve) => {
    let done = false;
    let everPlayed = false;
    let firstSoundFired = false;
    let everLoaded = false;
    let lastProgressAt = Date.now();
    let lastPositionSec = 0;
    // === FIX 2026-06-26 v11: traccia durata MP3 dichiarata da AVPlayer ===
    // status.duration arriva via playbackStatusUpdate dopo il primo frame
    // di metadata. Lo loggiamo una volta sola e lo usiamo per chiudere
    // pulitamente quando pos ≥ dur (evita lo stall watcher).
    let knownDurationLogged = false;
    let knownDurationSec: number | null = null;
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
      // === FIX 2026-06-25 v10: tail buffer ===
      // didJustFinish fa fede sull'evento "ended" di AVPlayer, ma il buffer
      // hardware iOS può avere ancora 50-150ms di audio da drenare. Se
      // facciamo cleanup + resolve immediatamente, e il chiamante avvia la
      // prossima frase con un nuovo player, quei 50-150ms vengono troncati
      // (sintomo: "si mangia le parole" tra una frase TTS e l'altra).
      // Concediamo un piccolo grace period prima di rilasciare il controllo.
      if (tailBufferMs > 0) {
        setTimeout(() => {
          try { cleanup(); } catch {}
          resolve(ok);
        }, tailBufferMs);
      } else {
        cleanup();
        resolve(ok);
      }
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
          const dur = typeof status.duration === "number" && status.duration > 0
            ? status.duration
            : null;
          if (pos > lastPositionSec) {
            lastPositionSec = pos;
            lastProgressAt = Date.now();
            // === FIX 2026-06-26 v11: log durata MP3 una sola volta ===
            // Permette di correlare nei log diag bytes vs durata reale.
            if (dur && !knownDurationLogged) {
              knownDurationLogged = true;
              console.log(`[KODA_TTS_PLAY] mp3_duration=${dur.toFixed(2)}s (pos=${pos.toFixed(2)})`);
              knownDurationSec = dur;
            }
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
          // === FIX 2026-06-26 v11 (root cause "frasi tagliate a metà") ===
          // Su iOS expo-audio v54, didJustFinish a volte NON viene emesso
          // alla fine del MP3 (la subscription smette di ricevere status
          // updates dopo qualche secondo). Risultato: il player rimane "vivo"
          // ma non avanza più la posizione, e lo stall watcher (a 12s da
          // ultimo progresso) chiamava finish→player.remove() TRONCANDO
          // l'audio in corso. Adesso: se il player ha avanzato fino a
          // ~250ms dalla fine del MP3, consideriamo il playback completo
          // e usciamo PULITAMENTE (didJustFinish-like) PRIMA che lo stall
          // watcher possa entrare in azione.
          if (dur && pos > 0 && pos >= dur - 0.25) {
            console.log(
              `[KODA_TTS_PLAY] duration_complete pos=${pos.toFixed(2)} ` +
                `dur=${dur.toFixed(2)} — finishing gracefully`
            );
            finish(true);
            return;
          }
        }
      });

      // === FIX 2026-06-26 v11: stall watcher meno aggressivo ===
      // Prima: soglia 12s — troppo bassa. Su iOS expo-audio v54 gli eventi
      // playbackStatusUpdate smettono di arrivare dopo ~5-10s di playback
      // per ragioni interne al SharedObject system, anche se l'audio
      // continua a suonare normalmente in AVPlayer. Lo stall watcher
      // interpretava questo come "audio bloccato" e chiamava player.remove()
      // → cut brutale dell'audio in corso (sintomo riportato dall'utente:
      // "frasi tagliate a metà, tutte esattamente a ~13.2s").
      // Ora: soglia 30s. Una frase ElevenLabs normale è max 15-20s; se
      // davvero blocca >30s è un problema vero che ha senso terminare.
      // In parallelo, la nuova logica "pos >= duration - 0.25" qui sopra
      // chiude la frase prima dello stall in caso di MP3 con duration nota.
      const STALL_THRESHOLD_MS = 30000;
      const stallWatcher = setInterval(() => {
        if (done) {
          clearInterval(stallWatcher);
          if (activeStallWatcher === stallWatcher) activeStallWatcher = null;
          return;
        }
        if (!everPlayed) return;
        const stalled = Date.now() - lastProgressAt;
        if (stalled > STALL_THRESHOLD_MS) {
          clearInterval(stallWatcher);
          if (activeStallWatcher === stallWatcher) activeStallWatcher = null;
          // Log con prefisso KODA_TTS_STALL così è visibile nel diag log
          // dell'utente (i log [speech] sono filtrati).
          console.log(
            `[KODA_TTS_STALL] stalled ${stalled}ms after pos=${lastPositionSec.toFixed(2)}s ` +
              `dur=${knownDurationSec ? knownDurationSec.toFixed(2) : "?"}s — forcing finish`
          );
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
  /**
   * === CLOSE SESSION (fix regressione 2026-06-20) ===
   * Backend imposta `true` quando l'utente saluta per chiudere
   * ("ci sentiamo dopo", "a dopo", "ciao Koda", "buonanotte", ecc.).
   * Il client DEVE smettere di ascoltare dopo aver suonato la reply
   * finale, altrimenti continua in loop ("non ti sento, parla pure").
   */
  close_session?: boolean;
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
    // === KODA_SUMMARY METRIC (sprint v11) ===
    // Durata in ms della registrazione utente che ha generato `text`.
    // Solo per scopi di logging — non viene inviata al backend.
    recordingDurationMs?: number;
    // === AUDIO HONESTY (Fabio 2026-06-23) ============================
    // Confidence Deepgram 0-1 della trascrizione. Se < 0.7 il backend
    // inietta una direttiva nel prompt che rende Koda onesto sull'audio
    // rumoroso (chiede dove si trova l'utente). Default: undefined →
    // comportamento storico identico, nessuna regressione.
    sttConfidence?: number;
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

  // === KODA_SUMMARY METRICS (sprint giugno 2026) ===
  // Tracciamo ogni step in modo che alla fine possiamo emettere UNA riga
  // riassuntiva pronta per essere copiata nella tabella di analisi:
  //   t0: invio richiesta /start
  //   tStartAck: server ha accettato la richiesta (200 OK con session_id)
  //   tMeta: arrivata la metadata (LLM ha finito di rispondere)
  //   tFirstAudio: il primo MP3 ha iniziato davvero a suonare (orecchio utente)
  //   tDone: il polling è finito (tutte le frasi ricevute)
  const t0 = Date.now();
  let tStartAck: number | null = null;
  let tMeta: number | null = null;
  let tFirstAudio: number | null = null;
  let tDone: number | null = null;
  let sentenceCount = 0;
  // Catturati dal meta event: identità path/modello effettivamente usati
  // dal backend. Permettono di intercettare fallback silenziosi.
  let summaryModel: string = "?";
  let summaryPath: string = "?";
  // === KODA_SUMMARY timing breakdown server-side (sprint v12) ===
  let summaryLlmTtftMs: number | null = null;
  let summaryFirstTtsMs: number | null = null;
  let summaryFirstAudioTotalMs: number | null = null;
  // === FIX 2026-06-20 (PM Claude richiesta): metrica onesta ===
  // `first_audio_total_ms` (alias storico `first_audio_srv`) marca solo
  // "MP3 in cache", NON "evento pubblicato e visibile al client". Quello
  // vero arriva con `event_published_ms`. Diff = costo publish+waveform.
  let summaryEventPublishedMs: number | null = null;

  // === KODA_POLL METRICS (sprint giugno 2026 — RCA gap server↔client) ===
  // Gap osservato dai log utente: first_audio_srv=2.3s vs first_audio=11s
  // (client). Differenza fino a 9 secondi senza spiegazione.
  // Logghiamo OGNI poll request/response + tempi chiave per identificare
  // dove si perdono i secondi (rete, JSON parse, AVPlayer buffer).
  let pollReqCount = 0;       // numero totale di POST /poll
  let pollEmptyCount = 0;     // poll che tornano 0 eventi (timeout server)
  let pollErrorCount = 0;     // poll falliti / 5xx / network error
  let pollTotalWaitMs = 0;    // somma del tempo speso DENTRO le fetch /poll
  let tFirstSentenceEvent: number | null = null;  // quando il client RICEVE il primo evento sentence
  let tFirstPlayStart: number | null = null;      // quando il player chiama play() sul primo token

  let summaryFinalized = false;
  const finalizeSummary = (errMsg?: string) => {
    if (summaryFinalized) return;
    summaryFinalized = true;
    const total = Date.now() - t0;
    const ms = (v: number | null) => (v == null ? "?" : String(v - t0));
    const status = errMsg ? `err=${errMsg.slice(0, 40)}` : "ok";
    const recMs = opts.recordingDurationMs;
    console.log(
      `[KODA_SUMMARY] model=${summaryModel} path=${summaryPath} ` +
        `total=${total}ms recording_ms=${recMs ?? "?"} ` +
        `transcript_chars=${text.length} ` +
        `llm_ttft=${summaryLlmTtftMs ?? "?"}ms ` +
        `first_tts=${summaryFirstTtsMs ?? "?"}ms ` +
        `audio_cached_srv=${summaryFirstAudioTotalMs ?? "?"}ms ` +
        `event_published_srv=${summaryEventPublishedMs ?? "?"}ms ` +
        `start_ack=${ms(tStartAck)}ms first_audio=${ms(tFirstAudio)}ms ` +
        `meta=${ms(tMeta)}ms done=${ms(tDone)}ms ` +
        `sentences=${sentenceCount} ${status}`
    );
    // === KODA_POLL_SUMMARY — bottleneck server↔client ===
    // GAP DIAGNOSI:
    //   first_sentence - first_audio_srv = ritardo "server pronto → client riceve evento"
    //                                       (se grande: rete o long-poll che si stalla)
    //   first_play - first_sentence     = ritardo "client riceve → player chiama play()"
    //                                       (se grande: JS event loop bloccato)
    //   first_audio - first_play        = ritardo "player.play() → primo frame audio"
    //                                       (se grande: AVPlayer buffering MP3 dal CDN)
    console.log(
      `[KODA_POLL_SUMMARY] polls=${pollReqCount} empty=${pollEmptyCount} ` +
        `err=${pollErrorCount} poll_wait=${pollTotalWaitMs}ms ` +
        `first_sentence=${ms(tFirstSentenceEvent)}ms ` +
        `first_play=${ms(tFirstPlayStart)}ms`
    );
  };

  try {
    // 1) Start the session.
    const startResp = await fetch(`${API_BASE}/converse-fast/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ephemeral: !!opts.ephemeral,
        audio_duration_ms: opts.audioDurationMs,
        // Audio honesty: passa la confidence Deepgram al backend (può
        // essere undefined/null per turni "text", o sempre per WS path).
        stt_confidence: typeof opts.sttConfidence === "number" ? opts.sttConfidence : undefined,
      }),
      signal: ac.signal,
    });
    if (!startResp.ok) {
      const errText = await startResp.text().catch(() => "");
      finalizeSummary(`start_${startResp.status}`);
      return { ok: false, error: `start failed: ${startResp.status} ${errText.slice(0, 200)}` };
    }
    const startData = await startResp.json();
    const sid = startData?.session_id;
    if (!sid || typeof sid !== "string") {
      finalizeSummary("no_sid");
      return { ok: false, error: "no session_id from server" };
    }
    tStartAck = Date.now();
    // === FILLER RIMOSSO (giugno 2026 v6) ===
    // Il filler audio è stato eliminato dal client e dal backend. Mostra
    // solo lo stato visuale (orb che pulsa) durante l'attesa. La prima
    // vera frase arriva in ~1.5-2s.

    // 2) Long-poll loop. Maintains a queue of pending tokens to play.
    let cursor = 0;
    let meta: FastConverseMeta | undefined;
    let pollingDone = false;
    let firstAudioFired = false;
    let pollError: string | null = null;

    const tokenQueue: { i: number; token: string; text: string; waveform?: number[] | null; window_ms?: number; isFiller?: boolean }[] = [];
    let resolveTokenWait: (() => void) | null = null;

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
        const _pollT0 = Date.now();
        pollReqCount++;
        try {
          const r = await fetch(
            `${API_BASE}/converse-fast/poll/${sid}?since=${cursor}&timeout=4`,
            { signal: ac.signal }
          );
          const _pollDur = Date.now() - _pollT0;
          pollTotalWaitMs += _pollDur;
          if (!r.ok) {
            pollErrorCount++;
            console.log(`[KODA_POLL] req=${pollReqCount} status=${r.status} dur=${_pollDur}ms cursor=${cursor} t=${Date.now() - t0}ms`);
            pollError = `poll ${r.status}`;
            pollingDone = true;
            notifyTokenWait();
            break;
          }
          const data = await r.json();
          const evts: any[] = data?.events || [];
          if (evts.length === 0) pollEmptyCount++;
          console.log(`[KODA_POLL] req=${pollReqCount} status=200 dur=${_pollDur}ms cursor=${cursor}→${data?.next} events=${evts.length} done=${!!data?.done} t=${Date.now() - t0}ms`);
          cursor = typeof data?.next === "number" ? data.next : cursor + evts.length;
          for (const ev of evts) {
            if (ev?.type === "sentence" && ev.token) {
              // Cattura timestamp ARRIVO primo evento sentence (per RCA gap server↔client)
              if (tFirstSentenceEvent === null) {
                tFirstSentenceEvent = Date.now();
              }
              tokenQueue.push({
                i: ev.i || 0,
                token: ev.token,
                text: ev.text || "",
                waveform: Array.isArray(ev.waveform) ? ev.waveform : null,
                window_ms: typeof ev.window_ms === "number" ? ev.window_ms : 60,
              });
              sentenceCount++;
              // Prima frase REALE arrivata → stop bridge filler.
              firstRealSentence = true;
              try { clearInterval(bridgeInterval); } catch {}
              notifyTokenWait();
            } else if (ev?.type === "meta") {
              tMeta = Date.now();
              if (typeof ev.model === "string") summaryModel = ev.model;
              if (typeof ev.path === "string") summaryPath = ev.path;
              if (typeof ev.llm_ttft_ms === "number") summaryLlmTtftMs = ev.llm_ttft_ms;
              if (typeof ev.first_tts_ms === "number") summaryFirstTtsMs = ev.first_tts_ms;
              if (typeof ev.first_audio_total_ms === "number") summaryFirstAudioTotalMs = ev.first_audio_total_ms;
              if (typeof ev.event_published_ms === "number") summaryEventPublishedMs = ev.event_published_ms;
              // === DIAG SPAGNOLO 2026-06-20 ===
              // Log immediato di profile_lang + preview reply. Una riga
              // chiara visibile su /diagnostics. Permette a Fabio di:
              //   1. Vedere SUBITO se profile.language è "es" (causa root)
              //   2. Confrontare il testo che Claude HA GENERATO con quello
              //      che SENTE: se reply_preview è in italiano ma sente
              //      spagnolo → bug TTS. Se entrambi spagnolo → bug LLM/profilo.
              // === DIAG TTS LANGUAGE 2026-06-20 v2 ===
              // Dopo aver forzato language_code="it" su tutte le chiamate
              // ElevenLabs, vogliamo VEDERE su /diagnostics ESATTAMENTE
              // quale voice_id + lang è stato usato per la risposta.
              // Se l'utente sente spagnolo ma vede tts_lang="it" e
              // tts_voice_id=Aria → bug nel modello ElevenLabs (escalation).
              if (
                typeof ev.profile_lang === "string" ||
                typeof ev.reply_preview === "string" ||
                typeof ev.tts_voice_id === "string"
              ) {
                console.log(
                  `[KODA_LLM_OUT_CLIENT] profile_lang=${ev.profile_lang ?? "?"} ` +
                  `koda_voice=${ev.koda_voice ?? "?"} ` +
                  `tts_voice_id=${(ev.tts_voice_id ?? "?").toString().slice(0, 12)}... ` +
                  `tts_lang=${ev.tts_lang ?? "?"} ` +
                  `tts_model=${ev.tts_model ?? "?"} ` +
                  `reply_preview=${JSON.stringify(ev.reply_preview ?? "").slice(0, 160)}`
                );
              }
              meta = {
                reply: ev.reply || "",
                voice_text: ev.voice_text ?? null,
                tone: (ev.tone as Tone) ?? null,
                actions: Array.isArray(ev.actions) ? ev.actions : [],
                // === CLOSE SESSION (fix regressione 2026-06-20) ===
                // Backend dice "true" su saluto di chiusura → il caller
                // (index.tsx) deve fermare il loop di registrazione auto.
                close_session: !!ev.close_session,
              };
              if (ev.close_session) {
                console.log("[KODA_CLOSE_SESSION] backend requested session end");
              }
              try { opts.onMeta?.(meta); } catch {}
            } else if (ev?.type === "waveform_update") {
              // === FIX 2026-06-20: waveform "late" ===
              // Il backend ora pubblica la sentence SUBITO (waveform=null)
              // e poi emette l'envelope RMS in un evento separato per
              // togliere ~1.3s dal percorso critico di first_audio.
              // Al momento ignoriamo i waveform tardivi: la prima frase
              // userà l'animazione default (degradazione cosmetica come
              // dichiarato nel piano). Quando vorremo applicare anche
              // l'envelope tardivo, useremo questo branch per inviare
              // il payload all'orb via callback dedicata.
              // (Lo logghiamo a basso volume per non spammare il summary.)
            } else if (ev?.type === "error") {
              pollError = String(ev.message || "server error");
              pollingDone = true;
              notifyTokenWait();
              break;
            }
          }
          if (data?.done) {
            pollingDone = true;
            tDone = Date.now();
            notifyTokenWait();
            break;
          }
        } catch (e: any) {
          const _pollDur = Date.now() - _pollT0;
          pollTotalWaitMs += _pollDur;
          if (ac.signal.aborted) {
            pollingDone = true;
            notifyTokenWait();
            break;
          }
          pollErrorCount++;
          console.log(`[KODA_POLL] req=${pollReqCount} status=NETERR dur=${_pollDur}ms cursor=${cursor} err=${String(e?.message || e).slice(0, 60)} t=${Date.now() - t0}ms`);
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
        // Marca quando il player effettivamente parte sul primo token
        // (utile per separare "ho ricevuto evento" da "ho chiamato play()").
        if (tFirstPlayStart === null) {
          tFirstPlayStart = Date.now();
          console.log(`[KODA_POLL] first_play_kick t=${Date.now() - t0}ms (sentence_recv→play=${tFirstSentenceEvent ? Date.now() - tFirstSentenceEvent : "?"}ms)`);
        }
        const fireStart = !firstAudioFired
          ? () => {
              firstAudioFired = true;
              tFirstAudio = Date.now();
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
      finalizeSummary("aborted");
      return { ok: false, error: "aborted" };
    }
    if (pollError) {
      finalizeSummary(pollError);
      return { ok: false, error: pollError, meta };
    }
    finalizeSummary();
    return { ok: true, meta };
  } catch (e: any) {
    if (ac.signal.aborted) {
      finalizeSummary("aborted");
      return { ok: false, error: "aborted" };
    }
    finalizeSummary(String(e?.message || e));
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
  // === FIX 2026-06-26 v14: logging granulare + timeout su iOS FS ===
  // Il diag log v13 ha mostrato che il player loop si ferma PRIMA dei log
  // `cycle_step` aggiunti nella playback function. L'unica chiamata fra
  // l'`arrived` log e il primo cycle_step è questa funzione. Quindi è
  // QUI che iOS hanga (probabilmente su writeAsStringAsync della SECONDA
  // scrittura consecutiva nello stesso turno, quando il FS è ancora
  // occupato col flush della prima). Mettiamo logging granulare e
  // timeout duro: se hanga >2s, restituiamo null e il chiamante salta
  // la frase invece di restare appeso 38s.
  const tStart = Date.now();
  try {
    const dir = (FileSystem as any).cacheDirectory;
    if (!dir) {
      console.log(`[KODA_TTS_WRITE] #${idx} no_dir → null`);
      return null;
    }
    const path = `${dir}koda_ws_${Date.now()}_${idx}.mp3`;
    const t1 = Date.now();
    const b64 = _bytesToBase64(bytes);
    const t2 = Date.now();
    console.log(
      `[KODA_TTS_WRITE] #${idx} b64_done bytes=${bytes.byteLength} ` +
        `b64_len=${b64.length} ms=${t2 - t1}`
    );
    // Timeout wrapper di 2.5s sulla scrittura iOS
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const writePromise: Promise<string | null> = (async () => {
      try {
        await (FileSystem as any).writeAsStringAsync(path, b64, {
          encoding: (FileSystem as any).EncodingType?.Base64 ?? "base64",
        });
        return path;
      } catch (e) {
        console.warn(`[KODA_TTS_WRITE] #${idx} writeAsString error:`, e);
        return null;
      }
    })();
    // === FIX 2026-06-26 v15: cancel timeout quando il write vince la race ===
    // Prima il setTimeout continuava a girare anche dopo write_ok, emettendo
    // un "TIMEOUT" log fuorviante 2.5s più tardi (osservato in tutti i log
    // di Build #14). Adesso lo cancelliamo non appena writePromise risolve.
    const result = await Promise.race([
      writePromise.then((r) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        return r;
      }),
      new Promise<string | null>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          console.log(
            `[KODA_TTS_WRITE] #${idx} TIMEOUT after 2500ms — falling back`
          );
          resolve(null);
        }, 2500);
      }),
    ]);
    if (timedOut) {
      // Lasciamo che la scrittura completi in background (fire-and-forget)
      // così iOS non resta a holding lock, ma noi non aspettiamo.
      writePromise.catch(() => {});
      return null;
    }
    if (result === null) {
      // writeAsStringAsync ha lanciato eccezione (catch interno → null).
      // Loggato già dall'inner catch, qui esciamo silenziosi.
      return null;
    }
    console.log(
      `[KODA_TTS_WRITE] #${idx} write_ok ms=${Date.now() - tStart} path_tail=${path.slice(-30)}`
    );
    return result;
  } catch (e) {
    console.warn("[ws] writeMp3ToFile failed:", e);
    return null;
  }
}

/** === FIX 2026-06-26 v14: fallback in-memory playback ===
 *  Se la scrittura su FS hanga o fallisce, riproduciamo il MP3 direttamente
 *  da memoria via data URI. Più lento del FS path normalmente, ma non
 *  dipende dal lock del FileSystem iOS → bypassa il hang. */
async function _playMp3FromMemoryFallback(
  bytes: Uint8Array,
  onStart?: () => void,
  playOpts?: { skipAudioSessionCycle?: boolean; tailBufferMs?: number }
): Promise<boolean> {
  try {
    const b64 = _bytesToBase64(bytes);
    const dataUri = `data:audio/mpeg;base64,${b64}`;
    console.log(`[KODA_TTS_PLAY] fallback data-uri len=${dataUri.length}`);
    return await playElevenLabsNativeFromUrl(dataUri, onStart, playOpts);
  } catch (e) {
    console.warn("[ws] memory fallback playback failed:", e);
    return false;
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
    // Audio honesty (Fabio 2026-06-23) — vedi commento in fastConverse.
    sttConfidence?: number;
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
        stt_confidence: typeof opts.sttConfidence === "number" ? opts.sttConfidence : undefined,
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
        // === FIX 2026-06-28 v28 — robustezza cross-realm (vedi voiceStream.ts) ===
        // Su Android RN `instanceof ArrayBuffer` può fallire per realm
        // mismatch. Usiamo lo stesso pattern a cascata del voiceStream.
        let u8: Uint8Array | null = null;
        const d: any = ev.data;
        try {
          if (d instanceof ArrayBuffer) {
            u8 = new Uint8Array(d);
          } else if (d && typeof d.byteLength === "number" && !d.buffer) {
            // ArrayBuffer-like cross-realm
            u8 = new Uint8Array(d);
          } else if (d?.buffer instanceof ArrayBuffer) {
            u8 = new Uint8Array(d.buffer);
          } else if (d?.buffer && typeof d.buffer.byteLength === "number") {
            // TypedArray cross-realm
            u8 = new Uint8Array(d.buffer);
          } else if (typeof d?.arrayBuffer === "function") {
            // Blob (web). Convertiamo in modo asincrono.
            d.arrayBuffer().then((buf: ArrayBuffer) => {
              if (pendingSentence) {
                sentenceQueue.push({
                  i: pendingSentence.i || 0,
                  bytes: new Uint8Array(buf),
                  waveform: Array.isArray(pendingSentence.waveform) ? pendingSentence.waveform : null,
                  window_ms: typeof pendingSentence.window_ms === "number" ? pendingSentence.window_ms : 60,
                });
                pendingSentence = null;
                notify();
              }
            }).catch((e: any) => console.warn(`[ws] Blob.arrayBuffer() failed: ${e}`));
            return; // dispatch asincrono — esci qui
          } else if (Array.isArray(d)) {
            u8 = new Uint8Array(d as number[]);
          }
        } catch (e) {
          console.warn(`[ws] binary normalize error: ${e}`);
        }
        if (!u8) {
          console.warn(
            `[ws] UNHANDLED binary frame — discarded ` +
              `ctor=${d?.constructor?.name || "?"}`
          );
          return;
        }
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

// =============================================================
// FASE 1 STREAMING — voiceStreamConverse (giugno 2026)
// =============================================================
// Wrapper attorno a VoiceStreamSession (rolling chunks AAC 500ms via WS)
// che mantiene la stessa interfaccia di fastConverseWS: il chiamante
// riceve onMeta, onAudioStart, e una Promise risolta con FastConverseResult.
// Internamente:
//  - apre la sessione streaming (WS verso /api/voice/stream)
//  - registra in rolling chunks finché Deepgram non dice "speech_final"
//  - quando arriva onSentence riusa la stessa coda+player loop di fastConverseWS
//  - ritorna quando arriva onDone (o errore/timeout)
// =============================================================
export async function voiceStreamConverse(opts: {
  ephemeral?: boolean;
  profileLang?: string;
  timeoutMs?: number;
  onAudioStart?: () => void;
  onMeta?: (meta: FastConverseMeta) => void;
  // Notifica del transcript finale dell'utente (per aggiornare la timeline
  // PRIMA che arrivi la risposta AI — UX più reattiva).
  onUserFinal?: (text: string, confidence: number | null, durationMs: number | null) => void;
  // Esposizione della sessione attiva al chiamante, per permettergli di
  // chiamare session.stop() da un tap sull'orb (barge-in / stop manuale).
  onSession?: (session: { stop: () => Promise<void> } | null) => void;
} = {}): Promise<FastConverseResult> {
  // === FIX 2026-06-26 v17: default alzato da 60s → 240s ===
  // Allineato con STREAM_HARD_CAP_MS (180s) + margine 60s per LLM+TTS.
  const timeoutMs = opts.timeoutMs ?? 240_000;
  stopAllPlayback();
  speakingNow = true;
  // === FIX 2026-06-25 v6 (root cause Build #4 RecordingDisabledException) ===
  // NON chiamiamo prewarmAudio() qui! prewarmAudio setta
  // allowsRecording:FALSE (è pensato per playback TTS) e annulla il
  // prewarmMic({allowsRecording:true}) che startTalkStreaming ha appena
  // fatto. Questo era il vero motivo per cui Build #1-4 fallivano con
  // RecordingDisabledException. Lo streaming deve INIZIARE in modalità
  // RECORD; il TTS che arriverà dopo gestirà il proprio switch a
  // playback mode quando serve (setAudioModeAsync è già chiamata
  // internamente da playElevenLabsNativeFromUrl).
  // await prewarmAudio();  ← DISABILITATO sul flusso streaming.

  const ac = new AbortController();
  currentAbort = ac;

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
  let pipelineDone = false;
  let pipelineError: string | null = null;

  const notify = () => { if (resolveTokenWait) { resolveTokenWait(); resolveTokenWait = null; } };
  const waitForToken = () => new Promise<void>((resolve) => {
    if (sentenceQueue.length > 0 || pipelineDone || pipelineError) { resolve(); return; }
    resolveTokenWait = resolve;
  });

  const hardTimer = setTimeout(() => {
    try { ac.abort(); } catch {}
    pipelineError = "voice-stream-timeout";
    pipelineDone = true;
    notify();
  }, timeoutMs);

  // Lazy import per evitare cicli (voiceStream.ts → ... → speech.ts)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { VoiceStreamSession } = require("./voiceStream");

  const session = new VoiceStreamSession({
    onReady: (sessionId: string) => {
      console.log(`[KODA_STREAM_CLIENT] ready sess=${sessionId.slice(0, 8)}`);
    },
    onInterim: (_text: string, _isFinal: boolean) => {
      // (UI live transcript — riservato per futura visualizzazione,
      // per ora silenzioso)
    },
    onFinal: (text: string, conf: number | null, dur: number | null) => {
      try { opts.onUserFinal?.(text, conf, dur); } catch {}
      // === ROLLBACK v16 (post-Build #15 test furgone) ===
      // Il prewarm v15 lanciato qui ha corrotto l'audio session iOS:
      // chiamava setIsAudioActiveAsync(false) MENTRE safeStopRecorder
      // del chunk loop era ancora in volo, lasciando iOS in stato
      // ambiguo. Risultato: il PROSSIMO recording (Turn 2) inviava
      // silenzio digitale a Deepgram → mai uno stt_final → 35s di
      // hang. Inoltre il prewarm faceva risolvere prematuramente la
      // prima frase TTS, triggerando auto-listen DURANTE il playback
      // della seconda frase ("se tagliato" nel test furgone).
      // Rollback: non chiamiamo prewarm qui. Il cycle audio session
      // gira normalmente dentro playElevenLabsNativeFromUrl quando
      // arriva la prima frase, come in Build #14 che era stabile.
      // prewarmPlaybackSession().catch(() => {});   ← DISABILITATO
    },
    onSentence: (header: any, audioBuf: ArrayBuffer) => {
      const u8 = new Uint8Array(audioBuf);
      sentenceQueue.push({
        i: header.i || 0,
        bytes: u8,
        waveform: Array.isArray(header.waveform) ? header.waveform : null,
        window_ms: typeof header.window_ms === "number" ? header.window_ms : 60,
      });
      notify();
    },
    onMeta: (meta: any) => {
      metaCaptured = {
        reply: meta.reply || "",
        voice_text: meta.voice_text ?? null,
        tone: (meta.tone as Tone) ?? null,
        actions: Array.isArray(meta.actions) ? meta.actions : [],
      };
      try { opts.onMeta?.(metaCaptured); } catch {}
    },
    onDone: () => {
      pipelineDone = true;
      notify();
    },
    onError: (msg: string) => {
      pipelineError = msg || "voice-stream-error";
      pipelineDone = true;
      notify();
    },
  });

  try {
    await session.start({
      ephemeral: opts.ephemeral,
      profileLang: opts.profileLang || "it",
    });
    // Esponi la sessione al chiamante per stop manuale (es. tap sull'orb).
    try { opts.onSession?.(session); } catch {}
  } catch (e: any) {
    clearTimeout(hardTimer);
    speakingNow = false;
    try { opts.onSession?.(null); } catch {}
    return { ok: false, error: `voice-stream-start-failed: ${e?.message || e}` };
  }

  // Player loop (identico al pattern di fastConverseWS) — riusa
  // _writeMp3ToFile + playElevenLabsNativeFromUrl + _playMp3BytesWeb già
  // dichiarati nel modulo.
  // === FIX 2026-06-25 v10 ("mangia le parole" tra frasi TTS) ===
  // Tracciamo se siamo sulla PRIMA frase dello stream: la prima richiede
  // il ciclo audio session deactivate→reactivate (transizione recording→playback),
  // tutte le successive lo saltano (skipAudioSessionCycle=true) per evitare
  // il troncamento del buffer hardware iOS tra una frase e l'altra.
  // Inoltre, ogni playback ha un piccolo tail buffer (~120ms) per drenare
  // il buffer audio prima di rilasciare il controllo alla frase dopo.
  let isFirstSentence = true;
  let sentenceCounter = 0;
  const tStreamStart = Date.now();
  try {
    while (!ac.signal.aborted) {
      if (sentenceQueue.length === 0) {
        if (pipelineDone || pipelineError) break;
        await waitForToken();
        continue;
      }
      const item = sentenceQueue.shift()!;
      sentenceCounter += 1;
      const sIdx = sentenceCounter;
      const tArrival = Date.now();
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
      console.log(
        `[KODA_TTS_PLAY] sent #${sIdx} arrived t+${tArrival - tStreamStart}ms ` +
          `bytes=${item.bytes.byteLength} queue_after=${sentenceQueue.length} ` +
          `first=${isFirstSentence}`
      );
      // === FIX 2026-06-26 v14 (vero root cause): wait inter-frase ===
      // ROOT CAUSE: su iOS, AVPlayer.remove() deallocala risorsa sul MAIN
      // THREAD. Per MP3 piccoli (~1-2s) la dealloc è veloce. Per MP3
      // grandi (5s+ con buffer hardware) la dealloc occupa il main thread
      // per decine/centinaia di ms. expo-file-system.writeAsStringAsync
      // dispatcha al main thread → resta in coda dietro la dealloc →
      // **blocca indefinitamente** dal punto di vista JS (osservato hang
      // sent #2 di 38s nel log v13 quando sent #1 era 5.67s).
      // FIX: per le frasi successive alla prima, attendiamo 200ms PRIMA
      // di scrivere il file. Dà al main thread iOS il tempo di completare
      // la dealloc dell'AVPlayer precedente. Cost: +200ms gap inter-frase.
      // Difensa in profondità: il timeout 2.5s in _writeMp3ToFile + il
      // fallback memory playback restano come safety net se il problema
      // si ripresenta in altre condizioni.
      if (!isFirstSentence) {
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      // === FIX 2026-06-26 v14 (abort guard #1) ===
      // Hard-stop dell'utente potrebbe essere arrivato durante il wait
      // sopra (o durante l'await su playElevenLabsNativeFromUrl della
      // frase precedente, che può bloccarsi 30s sullo stall watcher
      // se il player è stato rimosso esternamente da SpeechMod.stop()).
      // Senza questo check, la prossima frase partirebbe lo stesso →
      // "voce fantasma di Koda" 30s dopo che l'utente credeva di aver
      // silenziato tutto. Esci dal loop subito.
      if (ac.signal.aborted) {
        console.log(`[KODA_TTS_PLAY] sent #${sIdx} aborted before write — exit loop`);
        break;
      }
      try {
        if (Platform.OS === "web") {
          await _playMp3BytesWeb(item.bytes, fireStart);
        } else {
          const tWrite = Date.now();
          const path = await _writeMp3ToFile(item.bytes, item.i);
          const writeMs = Date.now() - tWrite;
          const playOpts = {
            skipAudioSessionCycle: false,
            tailBufferMs: 120,
          };
          // === FIX 2026-06-26 v14 (abort guard #2) ===
          // Se l'utente ha tappato l'hard-stop mentre _writeMp3ToFile era
          // in corso, NON avviamo nuovi player. Esci dal loop.
          if (ac.signal.aborted) {
            console.log(`[KODA_TTS_PLAY] sent #${sIdx} aborted before play — exit loop`);
            break;
          }
          if (!path) {
            // === FIX 2026-06-26 v14: fallback memory playback ===
            // _writeMp3ToFile può aver fatto TIMEOUT (FS iOS bloccato) o
            // fallito. Invece di saltare la frase (che lascia l'UI appesa
            // in "speaking" per sempre), proviamo a riprodurre direttamente
            // da memoria via data URI. Più lento ma robusto al hang FS.
            console.log(`[KODA_TTS_PLAY] sent #${sIdx} write_failed → fallback memory playback`);
            const tPlayStart = Date.now();
            await _playMp3FromMemoryFallback(item.bytes, fireStart, playOpts);
            const playMs = Date.now() - tPlayStart;
            console.log(
              `[KODA_TTS_PLAY] sent #${sIdx} done(fallback) play_ms=${playMs} ` +
                `total=${Date.now() - tArrival}ms`
            );
          } else {
            const tPlayStart = Date.now();
            await playElevenLabsNativeFromUrl(path, fireStart, playOpts);
            const playMs = Date.now() - tPlayStart;
            console.log(
              `[KODA_TTS_PLAY] sent #${sIdx} done write_ms=${writeMs} ` +
                `play_ms=${playMs} total=${Date.now() - tArrival}ms`
            );
          }
        }
      } catch (e) {
        console.warn(`[voice-stream] sentence #${sIdx} playback failed:`, e);
      }
      isFirstSentence = false;
      if (ac.signal.aborted) break;
    }
  } finally {
    try { await session.stop(); } catch {}
    try { opts.onSession?.(null); } catch {}
    clearTimeout(hardTimer);
    if (currentAbort === ac) currentAbort = null;
    speakingNow = false;
  }

  if (ac.signal.aborted) return { ok: false, error: "aborted" };
  if (pipelineError) return { ok: false, error: pipelineError, meta: metaCaptured };
  return { ok: true, meta: metaCaptured };
}

