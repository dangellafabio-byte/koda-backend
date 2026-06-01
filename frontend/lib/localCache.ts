/**
 * localCache.ts — cache JSON-locale su filesystem.
 *
 * Risolve il problema "schermata indaco" al cold start: quando l'app
 * apre e il backend è lento (preview in sleep, rete 3G, server cold start
 * in produzione), invece di mostrare una home vuota per N secondi,
 * leggiamo l'ultimo stato salvato sul telefono e mostriamo SUBITO
 * nome, sfondo, timeline, voce. In background poi sincronizziamo col
 * server.
 *
 * Storage: expo-file-system (già nel progetto). Non serve installare
 * altre dipendenze.
 *
 * Use cases:
 *  - PROFILE: ~2-5 KB JSON. Riusato per ad ogni render successivo.
 *  - TIMELINE: ~10-100 KB JSON. Riusato per la lista messaggi.
 *
 * Lifecycle:
 *  1. App apre → loadProfileCache() / loadTimelineCache() istantaneo
 *  2. UI si renderizza SUBITO con i dati cached
 *  3. In parallelo: fetch dal server con timeout/retry
 *  4. Quando il server risponde → saveProfileCache() / saveTimelineCache()
 *  5. Prossimo cold start → si parte già con dati freschi
 *
 * Tolleranza errori: tutte le operazioni sono "best effort". Se la
 * lettura/scrittura fallisce, l'app continua come se la cache fosse
 * vuota (= comportamento pre-cache).
 */

import * as FileSystem from "expo-file-system/legacy";

const PROFILE_FILE = (FileSystem.documentDirectory || "") + "profile_cache.json";
const TIMELINE_FILE = (FileSystem.documentDirectory || "") + "timeline_cache.json";

// Limita le entries timeline per evitare file giganti.
const TIMELINE_MAX_CACHE = 200;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    if (!FileSystem.documentDirectory) return null;
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(path);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  try {
    if (!FileSystem.documentDirectory) return;
    const json = JSON.stringify(data);
    await FileSystem.writeAsStringAsync(path, json);
  } catch {
    // ignore: cache non critica
  }
}

// =====================================================
// PROFILE
// =====================================================

export async function loadProfileCache<P = any>(): Promise<P | null> {
  return readJson<P>(PROFILE_FILE);
}

export async function saveProfileCache(profile: unknown): Promise<void> {
  if (!profile) return;
  return writeJson(PROFILE_FILE, profile);
}

// =====================================================
// TIMELINE
// =====================================================

export async function loadTimelineCache<T = any>(): Promise<T[] | null> {
  const arr = await readJson<T[]>(TIMELINE_FILE);
  if (!Array.isArray(arr)) return null;
  return arr;
}

export async function saveTimelineCache(timeline: unknown[]): Promise<void> {
  if (!Array.isArray(timeline)) return;
  // Filtra entries Fortezza (NON devono mai essere persistite su disco)
  const safe = (timeline as any[]).filter((e) => !e?.fortezza);
  // Tieni solo le ultime N entries
  const tail = safe.length > TIMELINE_MAX_CACHE
    ? safe.slice(-TIMELINE_MAX_CACHE)
    : safe;
  return writeJson(TIMELINE_FILE, tail);
}

// =====================================================
// CLEAR (usato al logout o reset)
// =====================================================

export async function clearAllCaches(): Promise<void> {
  try {
    if (!FileSystem.documentDirectory) return;
    const tasks = [PROFILE_FILE, TIMELINE_FILE].map(async (p) => {
      try {
        const info = await FileSystem.getInfoAsync(p);
        if (info.exists) await FileSystem.deleteAsync(p, { idempotent: true });
      } catch {}
    });
    await Promise.all(tasks);
  } catch {}
}
