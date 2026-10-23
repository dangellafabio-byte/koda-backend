/**
 * ttsProviderClient — Client per il selettore "Voce di Ollenya".
 * ================================================================
 *
 * Comunica con /api/tts/catalog, /api/tts/preferences via l'helper
 * `api` (lib/api.ts) che gestisce auth header. Niente SecureStore per
 * la fonte di verità — questa è il backend. Facciamo solo:
 *   * Cache in-memory del catalogo (statico post-boot)
 *   * Cache in-memory + fallback dell'ultima preferenza letta
 *
 * NON gestisce il consumo audio (resta sui vecchi flow in speech/voice).
 * NON scrive mai dati nel log console.
 */
import { API_BASE } from "./api";
import { getAuthToken } from "./authToken";

export type TTSProvider = "elevenlabs" | "inworld";

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
  label: string; // "Voce di Ollenya"
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

const _listeners = new Set<(prefs: TTSPrefs) => void>();

export const DEFAULT_PROVIDER: TTSProvider = "elevenlabs";

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

/**
 * Fetch catalogo voci di Ollenya. Pubblico, non richiede auth.
 * Cache in-memory per sessione.
 */
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

/**
 * Fetch preferenza utente. Richiede auth; 401 → ritorna null.
 * Cache in-memory per sessione, overridable con force=true.
 */
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
    _listeners.forEach((cb) => {
      try {
        cb(prefs);
      } catch {}
    });
    return prefs;
  } catch {
    return null;
  }
}

/**
 * Aggiorna preferenza utente. Il backend valida che la voce sia
 * disponibile sul provider richiesto; se non lo è → 409.
 * Ritorna la nuova preferenza, o lancia Error con message dal server.
 */
export async function updatePrefs(
  patch: Partial<Pick<TTSPrefs, "provider" | "voice_id">>
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
  _listeners.forEach((cb) => {
    try {
      cb(prefs);
    } catch {}
  });
  return prefs;
}

/**
 * Resetta la preferenza al default (ElevenLabs).
 */
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
  _listeners.forEach((cb) => {
    try {
      cb(prefs);
    } catch {}
  });
  return prefs;
}

/**
 * Subscribe a cambi di preferenza (dopo updatePrefs/fetchPrefs/resetPrefs).
 */
export function subscribePrefs(cb: (prefs: TTSPrefs) => void): () => void {
  _listeners.add(cb);
  return () => {
    _listeners.delete(cb);
  };
}

/**
 * Clear cache (es. su logout).
 */
export function clearCache(): void {
  _cachedCatalog = null;
  _cachedPrefs = null;
}
