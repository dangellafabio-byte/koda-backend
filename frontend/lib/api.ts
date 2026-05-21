/**
 * Taccuino Vivo — API client
 */

const detectBackend = (): string => {
  // EXPO_PUBLIC_BACKEND_URL is set in app .env. Falls back to relative /api on web.
  const env = process.env.EXPO_PUBLIC_BACKEND_URL;
  if (env) return env.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location) {
    return window.location.origin;
  }
  return "";
};

export const BACKEND = detectBackend();
export const API_BASE = `${BACKEND}/api`;

export type Domain = "soldi" | "tempo" | "spesa" | "salute" | "lavoro" | "casa" | "altro";
export type Tone = "neutral" | "calm" | "energetic" | "concerned" | "urgent" | "warm";

export type ExtractedFact = {
  domain?: Domain | null;
  intent?: string | null;
  amount?: number | null;
  currency?: string | null;
  item?: string | null;
  when?: string | null;
  flags?: string[];
};

export type Action = {
  type: "schedule_notification" | "cancel_notification" | string;
  when_iso?: string | null;
  title?: string | null;
  body?: string | null;
  identifier?: string | null;
  label?: string | null;
};

export type TimelineEntry = {
  id: string;
  role: "user" | "ai";
  text: string;            // Clean text for chat display (audio tags stripped)
  voice_text?: string | null; // AI replies: text with [audio tags] for ElevenLabs v3 TTS
  tone?: Tone | null;
  domain?: Domain | null;
  extracted?: ExtractedFact | null;
  actions?: Action[] | null;
  audio_duration_ms?: number | null;
  timestamp: string;
  /** True se questa entry è stata creata DURANTE il Confessionale.
   *  Lato client viene usato per:
   *    - nascondere il messaggio dalla timeline visibile quando il
   *      confessionale è OFF (privacy: se qualcuno apre l'app non
   *      può leggerli)
   *    - colorarlo in violetto/oscuro quando il confessionale è ON
   *      così l'utente capisce a colpo d'occhio quali sono.
   *  Non viene mai inviato/salvato sul backend (lì già non si scrive
   *  nulla in DB per ephemeral/sealed flow). */
  confessional?: boolean | null;
};

export type ProfileSettings = {
  ai_enabled: boolean;
  voice_response: boolean;
  full_access_mode: boolean;
  input_mode: "voice" | "text";
  theme: "sistema" | "notte" | "giorno" | "cielo" | "bosco" | "ciliegia";
  domains: Record<string, boolean>;
  tts_provider?: "elevenlabs" | "system";
  tts_voice_id?: string;
  tts_stability?: number;
  tts_similarity_boost?: number;
  day_start_hour?: number;
  night_start_hour?: number;
  conversation_mode?: boolean;
  hands_free?: boolean;             // True hands-free continuous listening (default true)
  background?: string | null;       // null | preset id | "data:image/...;base64,..."
  background_dim?: number;          // 0..1 dark overlay opacity
  ai_avatar?: string | null;        // Custom photo for AI avatar (base64 data URI)
  bubble_color?: string;            // "viola" | "verde_acqua" | "rosa" | "ambra" | "ghiaccio" | hex
  bubble_style?: "glass" | "solid"; // visual style applied to BOTH user and AI bubbles
  text_size?: number;               // 0.85 | 1.0 | 1.15 | 1.35
  // === Proactive Check-in (Coda reaches out without you asking) ===
  checkin_mode?: "off" | "morning" | "evening" | "both";
  checkin_morning_time?: string;    // local "HH:MM" e.g. "08:30"
  checkin_evening_time?: string;    // local "HH:MM" e.g. "21:30"
};

export type CheckinResponse = {
  title: string;
  body: string;
  voice_text: string;
  tone: Tone;
  slot: "morning" | "evening";
};

export type VoiceOption = {
  voice_id: string;
  name: string;
  description: string;
  gender: string;
  accent: string;
};

export type Profile = {
  id: string;
  language: string;
  onboarded: boolean;
  name?: string | null;
  // L'Amico Fraterno: identità AI + generi per declinazione lingua
  ai_name?: string;       // default "Coda" — UNICA variabile di identità modificabile
  ai_gender?: "m" | "f" | "n";  // default "f"
  user_gender?: "m" | "f" | "n"; // default "n"
  confidence_level: number;
  total_messages: number;
  settings: ProfileSettings;
  memory_summary: string;
  created_at: string;
  updated_at: string;
};

async function jsonReq<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status}: ${t}`);
  }
  return r.json();
}

export const api = {
  getProfile: () => jsonReq<Profile>("/profile"),
  updateProfile: (patch: Partial<Profile>) =>
    jsonReq<Profile>("/profile", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  resetEverything: () =>
    jsonReq<{ ok: boolean; message: string }>("/profile", { method: "DELETE" }),

  getTimeline: (limit = 200) =>
    jsonReq<TimelineEntry[]>(`/timeline?limit=${limit}`),
  clearTimeline: () => jsonReq<{ ok: boolean }>("/timeline", { method: "DELETE" }),

  converse: (
    text: string,
    audio_duration_ms?: number,
    opts?: { ephemeral?: boolean; bridged_secrets?: string[] }
  ) =>
    jsonReq<{
      user_entry: TimelineEntry;
      ai_entry: TimelineEntry;
      profile: Profile;
    }>("/converse", {
      method: "POST",
      body: JSON.stringify({
        text,
        audio_duration_ms,
        ephemeral: !!opts?.ephemeral,
        // PORTA FUORI: segreti DECRIFRATI dal client con la parola segreta,
        // inviati one-shot al backend solo per questo turno (forza ephemeral).
        // La parola segreta NON viene mai inviata.
        bridged_secrets: opts?.bridged_secrets,
      }),
    }),

  /** "Dimentica il fatto, ricorda l'insegnamento". */
  ghost: (entry_id: string, preserve_lesson: boolean = true) =>
    jsonReq<{ ok: boolean; lesson_preserved: boolean; lesson: string | null }>(
      "/ghost",
      {
        method: "POST",
        body: JSON.stringify({ entry_id, preserve_lesson }),
      }
    ),

  recap: (period: "today" | "week" = "today") =>
    jsonReq<{ recap: string; period: string }>(`/recap?period=${period}`),

  listVoices: () =>
    jsonReq<{ voices: VoiceOption[]; enabled: boolean }>("/voices"),

  generateCheckin: (slot: "morning" | "evening", local_hour: number) =>
    jsonReq<CheckinResponse>("/checkin/generate", {
      method: "POST",
      body: JSON.stringify({ slot, local_hour }),
    }),

  /** Confessionale Zero-Knowledge: invia messaggio cifrato + chiave volatile in header.
   * Server decifra in RAM, chiama Claude, ricifra. Niente è loggato/persistito.
   * `history_*` opzionali: turni precedenti della stessa sessione confessionale,
   * cifrati con la stessa chiave. Server li decifra in RAM e li passa a Claude
   * per dare continuità intra-confessionale. */
  /** Confessionale Zero-Knowledge: invia messaggio cifrato + chiave volatile in header.
   * Server decifra in RAM, chiama Claude, ricifra. Niente è loggato/persistito.
   * `history_*` opzionali: turni precedenti della stessa sessione confessionale,
   * cifrati con la stessa chiave. Server li decifra in RAM e li passa a Claude
   * per dare continuità intra-confessionale. */
  confessionalHistory: (limit: number = 200) =>
    jsonReq<{
      entries: Array<{ id: string; role: "user" | "ai"; nonce: string; ciphertext: string; ts: string }>;
      count: number;
    }>(`/confessional/history?limit=${limit}`),

  /** Numero di entries presenti nel vault (senza esporre contenuti).
   *  Usato fuori-Confessionale per dare a Koda awareness che "esiste un vault". */
  confessionalCount: () => jsonReq<{ count: number }>("/confessional/count"),

  converseSealed: (
    payload: {
      nonce: string;
      ciphertext: string;
      language?: string;
      ai_name?: string;
      ai_gender?: string;
      user_gender?: string;
      history_nonce?: string;
      history_ciphertext?: string;
    },
    keyB64: string
  ) =>
    jsonReq<{ nonce: string; ciphertext: string; tone: string }>(
      "/converse/sealed",
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "X-Sealed-Key": keyB64 },
      }
    ),

  /** Ricerca web pubblica (DuckDuckGo, no API key). */
  search: (query: string, max_results = 4) =>
    jsonReq<{ query: string; results: { title: string; snippet: string; url: string }[] }>(
      "/search",
      {
        method: "POST",
        body: JSON.stringify({ query, max_results }),
      }
    ),
};

// Tone -> color/icon map (UI helper)
export const toneStyle: Record<
  Tone,
  { bg: string; border: string; emoji: string; label: string }
> = {
  neutral: { bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.35)", emoji: "💬", label: "neutro" },
  calm: { bg: "rgba(56,189,248,0.10)", border: "rgba(56,189,248,0.4)", emoji: "🌊", label: "calmo" },
  warm: { bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.4)", emoji: "🤗", label: "caldo" },
  energetic: { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.4)", emoji: "⚡", label: "energico" },
  concerned: { bg: "rgba(249,115,22,0.10)", border: "rgba(249,115,22,0.45)", emoji: "🤔", label: "attento" },
  urgent: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.5)", emoji: "🚨", label: "urgente" },
};

export const domainBadge: Record<Domain, { emoji: string; label: string; color: string }> = {
  soldi: { emoji: "💶", label: "Soldi", color: "#FBBF24" },
  tempo: { emoji: "⏰", label: "Tempo", color: "#A78BFA" },
  spesa: { emoji: "🛒", label: "Spesa", color: "#34D399" },
  salute: { emoji: "❤️", label: "Salute", color: "#F87171" },
  lavoro: { emoji: "💼", label: "Lavoro", color: "#60A5FA" },
  casa: { emoji: "🏠", label: "Casa", color: "#F472B6" },
  altro: { emoji: "✨", label: "Altro", color: "#94A3B8" },
};
