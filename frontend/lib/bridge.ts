/**
 * bridge.ts — "bridge audio" (richiesta utente 2026-06: "velocità di risposta").
 *
 * Concept: quando l'utente smette di parlare, parte un mp3 intercalare
 * ("Mh.", "Ah ok.") con la stessa voce di Koda. Mentre il bridge suona,
 * la pipeline reale gira in background. La risposta vera subentra senza buco.
 *
 * 2026-06 — Fix:
 *   • Voice ID dinamico (era hardcoded Matilda → ora usa la voice corrente).
 *   • Pausa umana 600-900ms prima del bridge (no più "parte istantaneo
 *     come un robot": un umano aspetta un attimo prima dell'"ehm").
 */

import { createAudioPlayer, AudioPlayer } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

export type BridgeTier = "generico" | "riflessivo" | "opinione";

const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL || process.env.EXPO_BACKEND_URL || "";

const CACHE_DIR = `${FileSystem.cacheDirectory}bridges_v3/`;

// Voice ID corrente — settato da setBridgeVoiceId(). Default null = backend
// userà la voce Matilda default. Quando il main monta il profile, chiama
// setBridgeVoiceId(profile.settings.tts_voice_id) per allineare.
let currentVoiceId: string | null = null;
let counts: Record<BridgeTier, number> | null = null;
let prefetchedFor: string | null = null; // voice_id per cui abbiamo già fatto prefetch
const inMemory: Record<string, string> = {}; // key "voiceid:tier:i" → file uri

let currentPlayer: AudioPlayer | null = null;
let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
// Cancellation token: incrementiamo ad ogni stopBridge() → i timeout
// pendenti capiscono di essere obsoleti.
let playGeneration = 0;

/** Setter pubblico: il main lo chiama appena conosce la voice_id dell'utente. */
export function setBridgeVoiceId(voiceId: string | null): void {
  if (voiceId === currentVoiceId) return;
  currentVoiceId = voiceId;
  // Invalida prefetch: cambio voce → bisogna ri-scaricare per la nuova.
  if (prefetchedFor !== voiceId) {
    // Triggera nuovo prefetch in background (non blocchiamo qui).
    prefetchBridges().catch(() => {});
  }
}

/** Key univoca per cache (include voice_id per evitare collisioni tra voci) */
function cacheKey(tier: BridgeTier, i: number): string {
  return `${currentVoiceId || "default"}:${tier}:${i}`;
}

async function ensureDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
  } catch {}
}

async function fetchCounts(): Promise<Record<BridgeTier, number>> {
  if (counts) return counts;
  try {
    const res = await fetch(`${BACKEND_URL}/api/tts/bridge/count`);
    if (!res.ok) throw new Error(`bridge count HTTP ${res.status}`);
    counts = (await res.json()) as Record<BridgeTier, number>;
  } catch (e) {
    counts = { sobrio: 10, amichevole: 10, schietto: 10 };
  }
  return counts!;
}

async function downloadBridge(tier: BridgeTier, i: number): Promise<string | null> {
  const voiceSlug = (currentVoiceId || "default").replace(/[^a-zA-Z0-9]/g, "");
  const fileUri = `${CACHE_DIR}${voiceSlug}_${tier}_${i}.mp3`;
  const k = cacheKey(tier, i);
  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (info.exists && (info as any).size > 100) {
      inMemory[k] = fileUri;
      return fileUri;
    }
    let url = `${BACKEND_URL}/api/tts/bridge?style=${tier}&i=${i}`;
    if (currentVoiceId) url += `&voice_id=${encodeURIComponent(currentVoiceId)}`;
    const result = await FileSystem.downloadAsync(url, fileUri);
    if (result.status >= 200 && result.status < 300) {
      inMemory[k] = fileUri;
      return fileUri;
    }
  } catch {}
  return null;
}

/**
 * Pre-fetch bridges per la voice_id corrente. Idempotente: skippa se già
 * fatto per questa voice. Re-fetcha automaticamente se la voce cambia.
 */
export async function prefetchBridges(): Promise<void> {
  if (prefetchedFor === currentVoiceId) return;
  const inFlightFor = currentVoiceId;
  try {
    await ensureDir();
    const cnts = await fetchCounts();
    const tasks: Promise<any>[] = [];
    for (const tier of Object.keys(cnts) as BridgeTier[]) {
      for (let i = 0; i < cnts[tier]; i++) {
        tasks.push(downloadBridge(tier, i));
      }
    }
    await Promise.allSettled(tasks);
    if (currentVoiceId === inFlightFor) prefetchedFor = inFlightFor;
  } catch {
    /* allow retry */
  }
}

/**
 * Intent detection sul transcript dell'utente. Sceglie il tier di bridge:
 *   - opinione: l'utente chiede un giudizio/preferenza/opinione
 *               ("cosa ne pensi", "secondo te", "ti piace", "è giusto?")
 *   - riflessivo: domanda lunga/articolata (>12 parole o contiene
 *               "spiegami", "perché", "come mai", "raccontami") che
 *               richiede vera elaborazione
 *   - generico: tutto il resto, riempitivo puro
 * Nota: la funzione conserva il nome legacy detectTier per minimizzare
 * il refactor dei call site.
 */
export function detectTier(userText: string | null | undefined): BridgeTier {
  if (!userText) return "generico";
  const t = userText.toLowerCase().trim();
  // Pattern di richiesta di OPINIONE (priorità più alta)
  const opinionPattern = /(cosa ne pensi|che ne pensi|che dici|secondo te|tu (cosa|che) ne (pensi|dici)|ti (piace|sembra|pare)|è (giusto|sbagliato|corretto|vero)|sei d['']accordo|hai ragione|preferisci)/;
  if (opinionPattern.test(t)) return "opinione";
  // Pattern di domanda ARTICOLATA che richiede elaborazione
  const reflectPattern = /(spiegami|spiegami|raccontami|perch[éè]|come mai|in che modo|cosa intendi|cosa significa|spiega)/;
  if (reflectPattern.test(t)) return "riflessivo";
  // Domanda lunga (>12 parole) → riflessiva
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount > 12) return "riflessivo";
  return "generico";
}

/**
 * Riproduce un bridge intercalare DOPO un piccolo delay umano random
 * (600-900ms). Se nel frattempo arriva la risposta vera, stopBridge()
 * cancella il timeout pendente — nessun rumore.
 */
export async function playBridge(tier: BridgeTier = "generico"): Promise<void> {
  const myGen = ++playGeneration;
  // Cancella eventuali timeout pendenti precedenti
  if (pendingTimeout) {
    try { clearTimeout(pendingTimeout); } catch {}
    pendingTimeout = null;
  }

  // === DELAY UMANO (richiesta utente 2026-06, revisione 3) ===
  // 500-1200ms: abbastanza per essere "umano" (non scatta a zero come
  // un robot) ma SOTTO la latenza tipica della pipeline reale
  // (Deepgram + Claude + ElevenLabs = ~1.5-2.5s). Così il bridge fa
  // SEMPRE in tempo a partire prima della risposta vera.
  // Con un delay più alto (1-3s), la risposta vera spesso arrivava
  // prima del delay → stopBridge cancellava il timer → bridge muto.
  const delay = 500 + Math.floor(Math.random() * 700); // 500-1200ms

  return new Promise<void>((resolve) => {
    pendingTimeout = setTimeout(async () => {
      pendingTimeout = null;
      // Se nel frattempo siamo stati cancellati (stopBridge chiamato perché
      // la risposta vera è già pronta), non parte nulla.
      if (myGen !== playGeneration) {
        resolve();
        return;
      }
      try {
        const cnts = await fetchCounts();
        const n = cnts[tier] || 10;
        const available: number[] = [];
        for (let i = 0; i < n; i++) {
          if (inMemory[cacheKey(tier, i)]) available.push(i);
        }
        if (available.length === 0) {
          // Niente cache → triggera download in background per il futuro
          downloadBridge(tier, 0).catch(() => {});
          resolve();
          return;
        }
        // Re-check cancellation
        if (myGen !== playGeneration) { resolve(); return; }
        const idx = available[Math.floor(Math.random() * available.length)];
        const fileUri = inMemory[cacheKey(tier, idx)];
        if (currentPlayer) {
          try { currentPlayer.remove(); } catch {}
          currentPlayer = null;
        }
        const player = createAudioPlayer({ uri: fileUri });
        currentPlayer = player;
        try {
          player.volume = 1.0;
          player.play();
        } catch {}
      } catch {}
      resolve();
    }, delay);
  });
}

/**
 * Cancella sia un eventuale timeout PENDENTE (bridge non ancora partito)
 * sia un bridge IN CORSO. Da chiamare quando la risposta vera sta per partire.
 */
export function stopBridge(): void {
  playGeneration++; // invalida pending timeouts
  if (pendingTimeout) {
    try { clearTimeout(pendingTimeout); } catch {}
    pendingTimeout = null;
  }
  if (!currentPlayer) return;
  try {
    currentPlayer.pause();
    currentPlayer.remove();
  } catch {}
  currentPlayer = null;
}

export function isBridgePlaying(): boolean {
  if (!currentPlayer) return false;
  try {
    return (currentPlayer as any).playing === true || (currentPlayer as any).isPlaying === true;
  } catch {
    return false;
  }
}
