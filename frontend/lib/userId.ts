/**
 * Koda — User ID (UUID per-device).
 *
 * Genera/legge un UUID stabile dal SecureStore, usato come:
 *  - `X-User-Id` header su tutte le richieste backend (multi-user)
 *  - `appUserID` su RevenueCat (quando attiveremo l'SDK)
 *
 * Web/SSR fallback: usa localStorage o memoria.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEY = "koda_user_id_v1";

let _cached: string | null = null;
let _inflight: Promise<string> | null = null;

function _uuidv4(): string {
  // Implementazione semplice RFC 4122 v4 senza dipendenze esterne.
  // crypto.getRandomValues è disponibile in RN moderno (Hermes) e nei browser.
  const rnds = new Uint8Array(16);
  if (typeof (globalThis as any).crypto?.getRandomValues === "function") {
    (globalThis as any).crypto.getRandomValues(rnds);
  } else {
    for (let i = 0; i < 16; i++) rnds[i] = Math.floor(Math.random() * 256);
  }
  rnds[6] = (rnds[6] & 0x0f) | 0x40;
  rnds[8] = (rnds[8] & 0x3f) | 0x80;
  const hex = Array.from(rnds, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

async function _read(): Promise<string | null> {
  try {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.localStorage) {
        return window.localStorage.getItem(KEY);
      }
      return null;
    }
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

async function _write(v: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(KEY, v);
      }
      return;
    }
    await SecureStore.setItemAsync(KEY, v);
  } catch {
    /* ignore */
  }
}

/**
 * Restituisce (o genera) lo UUID utente.
 * Thread-safe (single inflight) e cached in memoria.
 */
export async function getUserId(): Promise<string> {
  if (_cached) return _cached;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    let v = await _read();
    if (!v || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      v = _uuidv4();
      await _write(v);
    }
    _cached = v.toLowerCase();
    return _cached;
  })();
  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

/** Per debug/testing: forza un nuovo UUID e lo ritorna. */
export async function resetUserId(): Promise<string> {
  _cached = null;
  const v = _uuidv4();
  await _write(v);
  _cached = v;
  return v;
}

/** Sincrono — ritorna null se non ancora inizializzato. */
export function getUserIdSync(): string | null {
  return _cached;
}
