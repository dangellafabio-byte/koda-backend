/**
 * bridge.ts — "bridge audio" (richiesta utente 2026-06: "velocità di risposta").
 *
 * Concept: quando l'utente smette di parlare, parte SUBITO un mp3
 * intercalare ("Mh.", "Ah ok.", "Allora vediamo...") con la stessa voce
 * di Koda. Mentre il bridge suona, in parallelo gira la pipeline reale
 * (Deepgram → Claude → ElevenLabs). Quando la risposta vera è pronta,
 * subentra senza buco.
 *
 * Per ottenere ZERO latenza, tutti i bridge sono pre-fetchati al boot
 * dell'app e cachati in /cache/bridges/. La riproduzione legge dal
 * filesystem locale → istantanea.
 *
 * Tone detection: in base al tono dell'utente (parolacce, colloquialità)
 * scegliamo il tier (sobrio | amichevole | schietto).
 */

import { createAudioPlayer, AudioPlayer } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

export type BridgeTier = "sobrio" | "amichevole" | "schietto";

const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL || process.env.EXPO_BACKEND_URL || "";

const CACHE_DIR = `${FileSystem.cacheDirectory}bridges/`;

let counts: Record<BridgeTier, number> | null = null;
let prefetched = false;
const inMemory: Record<string, string> = {}; // key "tier:i" → file uri

let currentPlayer: AudioPlayer | null = null;

/** Assicura che la directory di cache esista */
async function ensureDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
  } catch {}
}

/** Fetch la struttura (quante frasi per ciascun tier) */
async function fetchCounts(): Promise<Record<BridgeTier, number>> {
  if (counts) return counts;
  try {
    const res = await fetch(`${BACKEND_URL}/api/tts/bridge/count`);
    if (!res.ok) throw new Error(`bridge count HTTP ${res.status}`);
    counts = (await res.json()) as Record<BridgeTier, number>;
  } catch (e) {
    // fallback sicuro
    counts = { sobrio: 10, amichevole: 10, schietto: 10 };
  }
  return counts!;
}

/** Scarica UN bridge mp3 e lo salva su filesystem locale. Restituisce l'uri locale. */
async function downloadBridge(tier: BridgeTier, i: number): Promise<string | null> {
  const fileUri = `${CACHE_DIR}${tier}_${i}.mp3`;
  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (info.exists && (info as any).size > 100) {
      inMemory[`${tier}:${i}`] = fileUri;
      return fileUri;
    }
    const url = `${BACKEND_URL}/api/tts/bridge?style=${tier}&i=${i}`;
    const result = await FileSystem.downloadAsync(url, fileUri);
    if (result.status >= 200 && result.status < 300) {
      inMemory[`${tier}:${i}`] = fileUri;
      return fileUri;
    }
  } catch {}
  return null;
}

/**
 * Pre-fetch all bridges al boot dell'app. Chiamata "fire-and-forget"
 * (non blocca il rendering). Idempotente: se già fatto, ritorna subito.
 */
export async function prefetchBridges(): Promise<void> {
  if (prefetched) return;
  prefetched = true; // segno subito per evitare doppie chiamate concorrenti
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
  } catch {
    prefetched = false; // permettiamo retry
  }
}

/**
 * Determina il tier in base al testo (utente) — heuristic semplice:
 * - parolacce → schietto
 * - colloquiale (vabbè, boh, cazzo lieve) → amichevole
 * - altrimenti sobrio
 */
export function detectTier(userText: string | null | undefined): BridgeTier {
  if (!userText) return "amichevole";
  const t = userText.toLowerCase();
  const hard = /(cazzo|merda|fanculo|vaffa|porca|coglion|stronz)/;
  const colloq = /(vabb[èe]|boh|cavolo|cazzar|figata|figa[t,n]|capit[oa]\b)/;
  if (hard.test(t)) return "schietto";
  if (colloq.test(t)) return "amichevole";
  return "sobrio";
}

/**
 * Sceglie un bridge random per il tier dato e lo riproduce con un
 * AudioPlayer dedicato. Restituisce il player (l'ha già start-ato).
 * Se non c'è un bridge cachato disponibile, ritorna null silenziosamente.
 */
export async function playBridge(tier: BridgeTier = "amichevole"): Promise<AudioPlayer | null> {
  try {
    const cnts = await fetchCounts();
    const n = cnts[tier] || 10;
    // Scegli random tra quelli effettivamente scaricati
    const available: number[] = [];
    for (let i = 0; i < n; i++) {
      if (inMemory[`${tier}:${i}`]) available.push(i);
    }
    if (available.length === 0) {
      // Niente cache → fallback: prova a scaricarne uno al volo (non aspettiamo)
      downloadBridge(tier, 0).catch(() => {});
      return null;
    }
    const idx = available[Math.floor(Math.random() * available.length)];
    const fileUri = inMemory[`${tier}:${idx}`];
    // Ferma player precedente se ancora in corso
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
    return player;
  } catch {
    return null;
  }
}

/** Ferma immediatamente il bridge in corso (utile quando arriva la risposta vera). */
export function stopBridge(): void {
  if (!currentPlayer) return;
  try {
    currentPlayer.pause();
    currentPlayer.remove();
  } catch {}
  currentPlayer = null;
}

/** Verifica se un bridge è ancora in corso */
export function isBridgePlaying(): boolean {
  if (!currentPlayer) return false;
  try {
    return (currentPlayer as any).playing === true || (currentPlayer as any).isPlaying === true;
  } catch {
    return false;
  }
}
