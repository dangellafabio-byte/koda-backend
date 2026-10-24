/**
 * ttsProviderClient — Gestione provider TTS lato client (A/B dev).
 * ================================================================
 *
 * Fonte di verità locale: SecureStore chiave `ollenya_tts_provider_dev`.
 * Secondary: SecureStore chiave `ollenya_tts_provider_dev_uid` per legare
 * la preferenza all'account che l'ha attivata (previene propagazione a
 * utenti diversi su switch account/logout).
 *
 * Flusso approvato Fabio (Opzione B, 2026-10):
 *   1. Dalla chat l'owner riceve un token one-shot
 *   2. L'app in Impostazioni → sezione "Sperimentale" → tap "Attiva Inworld"
 *   3. L'app chiede il token (prompt), chiama POST /api/dev/tts-provider/activate
 *   4. Se OK → scrive SecureStore + imposta provider "inworld"
 *   5. Al logout o cambio account → clearIfDifferentUser()
 *
 * I componenti di intro/paywall/microdemo/LA usano il hook `useTTSProvider()`
 * (o la funzione imperativa `readTTSProviderSync()` per boot sync).
 */
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { API_BASE } from "./api";
import { getAuthToken } from "./authToken";

const KEY_PROVIDER = "ollenya_tts_provider_dev";
const KEY_UID = "ollenya_tts_provider_dev_uid";

export type TTSProvider = "elevenlabs" | "inworld";
export const DEFAULT_PROVIDER: TTSProvider = "elevenlabs";

// Cache in-memory (sync) per il resolve a boot time, prima che SecureStore
// restituisca il valore async. Viene popolata al primo load e aggiornata
// da ogni setProvider.
let _memoryProvider: TTSProvider = DEFAULT_PROVIDER;
let _memoryUid: string | null = null;
let _hydrated = false;
const _listeners = new Set<(p: TTSProvider) => void>();

/**
 * Legge la preferenza da SecureStore e popola la cache in-memory.
 * Idempotente: la prima chiamata idrata, le successive sono no-op.
 */
export async function hydrateTTSProvider(): Promise<TTSProvider> {
  if (_hydrated) return _memoryProvider;
  try {
    const p = await SecureStore.getItemAsync(KEY_PROVIDER);
    const u = await SecureStore.getItemAsync(KEY_UID);
    if (p === "inworld") {
      _memoryProvider = "inworld";
    } else {
      _memoryProvider = DEFAULT_PROVIDER;
    }
    _memoryUid = u;
  } catch {
    _memoryProvider = DEFAULT_PROVIDER;
    _memoryUid = null;
  }
  _hydrated = true;
  return _memoryProvider;
}

/**
 * Letto sincrono senza await — ritorna il valore attualmente in cache.
 * Prima di `hydrateTTSProvider()` ritorna sempre il default.
 * Usato dai componenti che caricano asset statici al mount (require).
 */
export function readTTSProviderSync(): TTSProvider {
  return _memoryProvider;
}

/**
 * Imposta localmente il provider + binding con l'uid. Lo salva in
 * SecureStore e notifica gli iscritti. Usato dopo che l'endpoint
 * backend ha validato il token one-shot.
 */
export async function setTTSProvider(
  provider: TTSProvider,
  uid: string | null
): Promise<void> {
  _memoryProvider = provider;
  _memoryUid = uid;
  _hydrated = true;
  try {
    await SecureStore.setItemAsync(KEY_PROVIDER, provider);
    if (uid) {
      await SecureStore.setItemAsync(KEY_UID, uid);
    } else {
      await SecureStore.deleteItemAsync(KEY_UID);
    }
  } catch (e) {
    // SecureStore può fallire su web → in-memory fallback
    console.warn("[ttsProviderClient] SecureStore set failed:", e);
  }
  _listeners.forEach((cb) => {
    try {
      cb(provider);
    } catch {}
  });
}

/**
 * Reset completo (torna a elevenlabs default).
 */
export async function clearTTSProvider(): Promise<void> {
  await setTTSProvider(DEFAULT_PROVIDER, null);
}

/**
 * Al login/cambio account: se l'uid della sessione è diverso da quello
 * che ha attivato Inworld, resettiamo a default per evitare che le
 * preferenze di Fabio si applichino ad altri utenti.
 */
export async function reconcileWithCurrentUid(uid: string | null): Promise<void> {
  if (!_hydrated) await hydrateTTSProvider();
  if (_memoryProvider === DEFAULT_PROVIDER) return; // niente da fare
  if (!uid) {
    // Logout → non toccare, Fabio lo riattiverà al prossimo login
    return;
  }
  if (_memoryUid && _memoryUid !== uid) {
    console.log("[ttsProviderClient] uid mismatch → clearing (was",
                _memoryUid, "now", uid, ")");
    await clearTTSProvider();
  }
}

/**
 * Hook React — ritorna il provider corrente, aggiornato automaticamente
 * quando setTTSProvider() viene chiamato.
 */
export function useTTSProvider(): TTSProvider {
  const [p, setP] = useState<TTSProvider>(_memoryProvider);
  useEffect(() => {
    if (!_hydrated) {
      hydrateTTSProvider().then(setP);
    }
    const listener = (next: TTSProvider) => setP(next);
    _listeners.add(listener);
    return () => {
      _listeners.delete(listener);
    };
  }, []);
  return p;
}

/**
 * Helper che chiama il backend per rilasciare un token one-shot.
 * Solo per account whitelisted (gate server-side).
 */
export async function issueSwitchToken(
  backendUrl: string,
  authHeaders: Record<string, string>,
  provider: TTSProvider = "inworld"
): Promise<{ token: string; expires_at: string; ttl_minutes: number }> {
  const res = await fetch(`${backendUrl}/api/dev/tts-provider/issue-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) throw new Error(`issue-token HTTP ${res.status}`);
  return res.json();
}

/**
 * Consuma un token one-shot ricevuto via chat.
 */
export async function activateWithToken(
  backendUrl: string,
  authHeaders: Record<string, string>,
  token: string,
  uid: string
): Promise<{ provider: TTSProvider; activated_at: string }> {
  const res = await fetch(`${backendUrl}/api/dev/tts-provider/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`activate HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  await setTTSProvider(data.provider, uid);
  return data;
}

/**
 * Reset lato backend (rimuove la pref dal DB) + lato client.
 */
export async function resetProviderOnServer(
  backendUrl: string,
  authHeaders: Record<string, string>
): Promise<void> {
  try {
    await fetch(`${backendUrl}/api/dev/tts-provider/me`, {
      method: "DELETE",
      headers: authHeaders,
    });
  } catch {}
  await clearTTSProvider();
}

/**
 * Check whitelist dal backend (ritorna { provider, whitelisted }).
 * Se risponde 403 → l'account NON è autorizzato → mostriamo UI di default.
 */
export async function readProviderFromServer(
  backendUrl: string,
  authHeaders: Record<string, string>
): Promise<{ provider: TTSProvider; whitelisted: boolean } | null> {
  try {
    const res = await fetch(`${backendUrl}/api/dev/tts-provider/me`, {
      headers: authHeaders,
    });
    if (res.status === 403) return { provider: DEFAULT_PROVIDER, whitelisted: false };
    if (!res.ok) return null;
    const data = await res.json();
    return { provider: data.provider, whitelisted: !!data.whitelisted };
  } catch {
    return null;
  }
}

// =============================================================================
// Catalog + Preferences API (fusione 2026-10 — selettore pubblico "Voce di Ollenya")
// =============================================================================
// Convive con il flusso SecureStore sopra: le due API sono complementari.
//   * SecureStore layer: cache locale veloce usata dai component asset-loader
//     (`readTTSProviderSync`) + attivazione via dev-token.
//   * Catalog/Preferences layer: fonte di verità lato server, usata dal
//     selettore UI "Voce di Ollenya" per DB-persisted prefs {provider,voice_id}.
// NB: dopo `updatePrefs()` chiamiamo anche `setTTSProvider()` per allineare la
// cache SecureStore con quanto appena scelto, così i component asset-loader
// vedono subito il nuovo provider.

export interface VoiceEntry {
  key: string; // "cielo" | "vento"
  name: string;
  gender: "femminile" | "maschile";
  description: string;
  elevenlabs_voice_id: string | null;
  available_on: TTSProvider[];
}

export interface ProviderMeta {
  name: string;
  description: string;
  model_locked?: boolean;
}

export interface TTSCatalog {
  label: string;
  default_provider: TTSProvider;
  allowed_providers: TTSProvider[];
  providers_meta: Record<TTSProvider, ProviderMeta>;
  voices: VoiceEntry[];
}

export interface TTSPrefs {
  provider: TTSProvider;
  voice_id: string | null;
  updated_at: string | null;
}

let _cachedCatalog: TTSCatalog | null = null;
let _cachedPrefs: TTSPrefs | null = null;
const _prefsListeners = new Set<(prefs: TTSPrefs) => void>();

function _apiBase(): string {
  try {
    if (typeof API_BASE === "string" && API_BASE.length > 0) {
      return API_BASE.replace(/\/$/, "");
    }
  } catch {}
  return (
    (process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/$/, "") || ""
  );
}

async function _authHeaders(): Promise<Record<string, string>> {
  try {
    const tok = getAuthToken();
    if (tok) return { Authorization: `Bearer ${tok}` };
  } catch {}
  return {};
}

/** Fetch catalogo voci di Ollenya. Pubblico, non richiede auth. */
export async function fetchCatalog(): Promise<TTSCatalog | null> {
  if (_cachedCatalog) return _cachedCatalog;
  try {
    const base = _apiBase();
    const res = await fetch(`${base}/tts/catalog`);
    if (!res.ok) return null;
    const data = (await res.json()) as TTSCatalog;
    _cachedCatalog = data;
    return data;
  } catch {
    return null;
  }
}

/** Fetch preferenza utente. Richiede auth; 401 → ritorna null. */
export async function fetchPrefs(force = false): Promise<TTSPrefs | null> {
  if (!force && _cachedPrefs) return _cachedPrefs;
  try {
    const base = _apiBase();
    const headers = await _authHeaders();
    const res = await fetch(`${base}/tts/preferences`, { headers });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const prefs: TTSPrefs = {
      provider: (data.provider as TTSProvider) || DEFAULT_PROVIDER,
      voice_id: data.voice_id ?? null,
      updated_at: data.updated_at ?? null,
    };
    _cachedPrefs = prefs;
    _prefsListeners.forEach((cb) => { try { cb(prefs); } catch {} });
    return prefs;
  } catch {
    return null;
  }
}

/** Aggiorna preferenza utente. Mantiene allineato il layer SecureStore. */
export async function updatePrefs(
  patch: Partial<Pick<TTSPrefs, "provider" | "voice_id">>,
  uid?: string | null,
): Promise<TTSPrefs> {
  const base = _apiBase();
  const headers = {
    "Content-Type": "application/json",
    ...(await _authHeaders()),
  };
  const res = await fetch(`${base}/tts/preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.detail) msg = String(b.detail);
    } catch {}
    throw new Error(msg);
  }
  const data = (await res.json()) as any;
  const prefs: TTSPrefs = {
    provider: (data.provider as TTSProvider) || DEFAULT_PROVIDER,
    voice_id: data.voice_id ?? null,
    updated_at: data.updated_at ?? null,
  };
  _cachedPrefs = prefs;
  _prefsListeners.forEach((cb) => { try { cb(prefs); } catch {} });
  // Allinea layer SecureStore con la nuova scelta → asset-loaders vedono subito
  try { await setTTSProvider(prefs.provider, uid ?? null); } catch {}
  return prefs;
}

/** Resetta la preferenza al default (ElevenLabs). */
export async function resetPrefs(): Promise<TTSPrefs> {
  const base = _apiBase();
  const headers = await _authHeaders();
  const res = await fetch(`${base}/tts/preferences`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as any;
  const prefs: TTSPrefs = {
    provider: (data.provider as TTSProvider) || DEFAULT_PROVIDER,
    voice_id: null,
    updated_at: null,
  };
  _cachedPrefs = prefs;
  _prefsListeners.forEach((cb) => { try { cb(prefs); } catch {} });
  try { await clearTTSProvider(); } catch {}
  return prefs;
}

/** Subscribe a cambi di preferenza (DB layer). */
export function subscribePrefs(cb: (prefs: TTSPrefs) => void): () => void {
  _prefsListeners.add(cb);
  return () => { _prefsListeners.delete(cb); };
}

/** Clear cache (es. su logout). */
export function clearCache(): void {
  _cachedCatalog = null;
  _cachedPrefs = null;
}
