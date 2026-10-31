// frontend/lib/audioStore.ts — Replay bit-exact per i messaggi di Ollenya
// (Fabio 2026-11-04).
//
// Obiettivo:
//   Il tap su una bolla AI deve riprodurre esattamente l'audio generato
//   la prima volta. Zero chiamate a Claude, Inworld, ElevenLabs, TTS web
//   locale. Se l'audio originale manca → messaggio esplicito di
//   "riascolto non disponibile", MAI fallback a rigenerazione.
//
// Design:
//   - Un segmento TTS = 1 file MP3 su disco (`${docDir}koda/audio/<uid>/
//     <mid>/<idx>.mp3`).
//   - Un messaggio = 1 directory + 1 file `meta.json` con metadati.
//   - Scrittura asincrona non-bloccante (fire-and-forget): la prima
//     risposta non deve attendere il salvataggio prima di iniziare a
//     parlare. Il caller usa `appendSegment()` dentro una Promise non
//     awaited.
//   - Isolamento per utente: la path include `user_id`, e il meta.json
//     ne ricopia il valore. Lettura richiede matching `user_id`.
//   - Pulizia esplicita: `cleanup({ maxAgeMs, maxMessages })`. Non
//     facciamo garbage-collect implicito su ogni write.
//
// Flag di attivazione:
//   `EXPO_PUBLIC_REPLAY_BIT_EXACT` ∈ {"1", "0"}. Default "1" (ON).
//   Se "0", le API appendSegment/read restituiscono rispettivamente
//   no-op/null → il caller cade sul comportamento pre-2026-11-04
//   (il tap sulla bolla può comportarsi come prima della riforma).

import * as FileSystem from "expo-file-system/legacy";

// Costanti ───────────────────────────────────────────────────────────
const ROOT_SUBDIR = "koda/audio";
const META_FILENAME = "meta.json";

// Policy di default (sovrascrivibile da chi chiama cleanup())
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 giorni
export const DEFAULT_MAX_MESSAGES_PER_USER = 100;

// Shape dei metadati salvati
export type SegmentMeta = {
  idx: number;              // ordine di generazione (0-based)
  file: string;             // nome file relativo (`${idx}.mp3`)
  chars: number;            // lunghezza testo sintetizzato
  text?: string | null;     // testo originale (opzionale, utile per debug)
  tone?: string | null;
  voice_id?: string | null;
  model_id?: string | null;
  provider?: string | null; // 'inworld' | 'elevenlabs'
  size_bytes: number;
  created_at: number;       // Date.now()
};

export type MessageMeta = {
  message_id: string;
  user_id: string;
  created_at: number;
  updated_at: number;
  schema_version: 1;
  segments: SegmentMeta[];
};

// Helpers path ───────────────────────────────────────────────────────
const docDir = (FileSystem.documentDirectory || "") as string;

const rootDir = (): string => `${docDir}${ROOT_SUBDIR}/`;

const userDir = (userId: string): string => `${rootDir()}${sanitizeId(userId)}/`;

const messageDir = (userId: string, messageId: string): string =>
  `${userDir(userId)}${sanitizeId(messageId)}/`;

const metaPath = (userId: string, messageId: string): string =>
  `${messageDir(userId, messageId)}${META_FILENAME}`;

// Prevenire path traversal: solo [A-Za-z0-9_-] accettati.
function sanitizeId(raw: string): string {
  return (raw || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "_";
}

// Flag master
export function isBitExactReplayEnabled(): boolean {
  const v = (process.env.EXPO_PUBLIC_REPLAY_BIT_EXACT || "1").trim();
  return v !== "0";
}

// Scrittura (safe → non lancia mai) ──────────────────────────────────
async function ensureDir(path: string): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(path, { intermediates: true });
    }
  } catch {}
}

async function readMeta(userId: string, messageId: string): Promise<MessageMeta | null> {
  try {
    const p = metaPath(userId, messageId);
    const info = await FileSystem.getInfoAsync(p);
    if (!info.exists) return null;
    const txt = await FileSystem.readAsStringAsync(p);
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.user_id !== userId) return null; // isolamento utente
    return parsed as MessageMeta;
  } catch {
    return null;
  }
}

async function writeMeta(meta: MessageMeta): Promise<void> {
  try {
    const dir = messageDir(meta.user_id, meta.message_id);
    await ensureDir(dir);
    await FileSystem.writeAsStringAsync(
      metaPath(meta.user_id, meta.message_id),
      JSON.stringify(meta),
    );
  } catch {}
}

/**
 * Scrive asincronamente un segmento MP3. Non lancia mai eccezioni:
 * il fallimento è loggato in console ma la pipeline del caller continua.
 *
 * Chiamare SENZA await per non bloccare il playback della prima risposta.
 */
export async function appendSegment(params: {
  userId: string;
  messageId: string;
  idx: number;
  bytes: Uint8Array;
  text?: string | null;
  tone?: string | null;
  voiceId?: string | null;
  modelId?: string | null;
  provider?: string | null;
}): Promise<void> {
  if (!isBitExactReplayEnabled()) return;
  const { userId, messageId, idx, bytes } = params;
  if (!userId || !messageId || !bytes || bytes.byteLength === 0) return;
  try {
    const dir = messageDir(userId, messageId);
    await ensureDir(dir);
    const file = `${idx}.mp3`;
    const filepath = `${dir}${file}`;
    // Scrittura base64 (RN FS legacy accetta base64 encoding option)
    const b64 = toBase64(bytes);
    await FileSystem.writeAsStringAsync(filepath, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    // Aggiorna meta.json (CAS semplice: read-modify-write)
    const existing = await readMeta(userId, messageId);
    const now = Date.now();
    const segMeta: SegmentMeta = {
      idx,
      file,
      chars: (params.text || "").length,
      text: params.text || null,
      tone: params.tone || null,
      voice_id: params.voiceId || null,
      model_id: params.modelId || null,
      provider: params.provider || null,
      size_bytes: bytes.byteLength,
      created_at: now,
    };
    const nextMeta: MessageMeta = existing
      ? {
          ...existing,
          updated_at: now,
          segments: [
            ...existing.segments.filter((s) => s.idx !== idx),
            segMeta,
          ].sort((a, b) => a.idx - b.idx),
        }
      : {
          message_id: messageId,
          user_id: userId,
          created_at: now,
          updated_at: now,
          schema_version: 1,
          segments: [segMeta],
        };
    await writeMeta(nextMeta);
  } catch (e) {
    console.warn(`[audioStore] appendSegment failed: ${e}`);
  }
}

export type ReplayPayload = {
  ok: true;
  segments: {
    idx: number;
    filepath: string;
    size_bytes: number;
    duration_hint_ms?: number | null;
  }[];
  meta: MessageMeta;
};

export type ReplayUnavailable = {
  ok: false;
  reason:
    | "feature_disabled"
    | "missing_meta"
    | "missing_segments"
    | "user_mismatch"
    | "zero_segments";
  user_id?: string;
  message_id?: string;
};

/**
 * Legge il manifest di un messaggio e verifica che TUTTI i file MP3
 * siano presenti sul filesystem. Se anche uno manca → `ok=false` con
 * reason `missing_segments`. Nessun fallback a rigenerazione: il
 * caller mostra "riascolto non disponibile".
 */
export async function readForReplay(
  userId: string,
  messageId: string,
): Promise<ReplayPayload | ReplayUnavailable> {
  if (!isBitExactReplayEnabled()) {
    return { ok: false, reason: "feature_disabled", user_id: userId, message_id: messageId };
  }
  const meta = await readMeta(userId, messageId);
  if (!meta) {
    return { ok: false, reason: "missing_meta", user_id: userId, message_id: messageId };
  }
  if (meta.user_id !== userId) {
    return { ok: false, reason: "user_mismatch" };
  }
  if (!Array.isArray(meta.segments) || meta.segments.length === 0) {
    return { ok: false, reason: "zero_segments", user_id: userId, message_id: messageId };
  }
  const dir = messageDir(userId, messageId);
  const ordered = [...meta.segments].sort((a, b) => a.idx - b.idx);
  const payload: ReplayPayload["segments"] = [];
  for (const s of ordered) {
    const filepath = `${dir}${s.file}`;
    try {
      const info = await FileSystem.getInfoAsync(filepath);
      if (!info.exists || (typeof info.size === "number" && info.size === 0)) {
        return {
          ok: false,
          reason: "missing_segments",
          user_id: userId,
          message_id: messageId,
        };
      }
    } catch {
      return {
        ok: false,
        reason: "missing_segments",
        user_id: userId,
        message_id: messageId,
      };
    }
    payload.push({ idx: s.idx, filepath, size_bytes: s.size_bytes });
  }
  return { ok: true, segments: payload, meta };
}

// Pulizia esplicita ──────────────────────────────────────────────────
export type CleanupStats = {
  users_scanned: number;
  messages_removed_by_age: number;
  messages_removed_by_count: number;
  errors: number;
};

export async function cleanup(
  opts: { maxAgeMs?: number; maxMessagesPerUser?: number } = {},
): Promise<CleanupStats> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxMsgs = opts.maxMessagesPerUser ?? DEFAULT_MAX_MESSAGES_PER_USER;
  const stats: CleanupStats = {
    users_scanned: 0,
    messages_removed_by_age: 0,
    messages_removed_by_count: 0,
    errors: 0,
  };
  try {
    const root = rootDir();
    const rootInfo = await FileSystem.getInfoAsync(root);
    if (!rootInfo.exists) return stats;
    const users = await FileSystem.readDirectoryAsync(root);
    const now = Date.now();
    for (const uid of users) {
      stats.users_scanned += 1;
      const udir = `${root}${uid}/`;
      let msgs: string[] = [];
      try {
        msgs = await FileSystem.readDirectoryAsync(udir);
      } catch {
        stats.errors += 1;
        continue;
      }
      // Scorri meta per età
      const kept: { mid: string; updated_at: number }[] = [];
      for (const mid of msgs) {
        try {
          const m = await readMeta(uid, mid);
          if (!m) continue;
          if (now - m.updated_at > maxAgeMs) {
            await FileSystem.deleteAsync(`${udir}${mid}/`, { idempotent: true });
            stats.messages_removed_by_age += 1;
          } else {
            kept.push({ mid, updated_at: m.updated_at });
          }
        } catch {
          stats.errors += 1;
        }
      }
      // Taglia per count: tiene i più recenti
      if (kept.length > maxMsgs) {
        kept.sort((a, b) => b.updated_at - a.updated_at);
        const toDrop = kept.slice(maxMsgs);
        for (const { mid } of toDrop) {
          try {
            await FileSystem.deleteAsync(`${udir}${mid}/`, { idempotent: true });
            stats.messages_removed_by_count += 1;
          } catch {
            stats.errors += 1;
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[audioStore] cleanup error: ${e}`);
  }
  return stats;
}

// Base64 encoder (puro JS, no deps) ──────────────────────────────────
function toBase64(bytes: Uint8Array): string {
  // Fast path web
  // @ts-ignore
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    // @ts-ignore
    return btoa(bin);
  }
  // RN polyfill via Buffer
  // @ts-ignore
  if (typeof Buffer !== "undefined") {
    // @ts-ignore
    return Buffer.from(bytes).toString("base64");
  }
  // Fallback puro
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i];
    const b = i + 1 < len ? bytes[i + 1] : 0;
    const c = i + 2 < len ? bytes[i + 2] : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < len ? chars[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < len ? chars[c & 63] : "=";
  }
  return out;
}

// Export per i test
export const _internal = {
  sanitizeId,
  rootDir,
  userDir,
  messageDir,
  metaPath,
  readMeta,
  writeMeta,
  toBase64,
};
