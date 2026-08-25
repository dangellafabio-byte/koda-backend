/**
 * Taccuino Vivo — API client
 */
import { KODA_BACKEND_URL } from "./backendUrl";

const detectBackend = (): string => {
  // === PIANO B 2026-07-19 — hardcoded Railway URL ===
  // EXPO_PUBLIC_BACKEND_URL viene ripristinato automaticamente dal sistema
  // Emergent al vecchio preview.emergentagent.com. Usiamo KODA_BACKEND_URL
  // (hardcoded Railway) come SORGENTE UNICA. Vedi lib/backendUrl.ts.
  return KODA_BACKEND_URL.replace(/\/$/, "");
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
};

export type ProfileSettings = {
  ai_enabled: boolean;
  voice_response: boolean;
  full_access_mode: boolean;
  input_mode: "voice" | "text";
  theme: "notte";
  domains: Record<string, boolean>;
  tts_provider?: "elevenlabs" | "system";
  tts_voice_id?: string;
  tts_stability?: number;
  tts_similarity_boost?: number;
  day_start_hour?: number;
  night_start_hour?: number;
  conversation_mode?: boolean;
  hands_free?: boolean;             // True hands-free continuous listening (default true)
  background?: string | null;       // DEPRECATED (2026-07-02) — mantenuto solo per backward-compat retention type. Server scarta il campo in ingresso.
  background_dim?: number;          // 0..1 dark overlay opacity (usato dagli sfondi PRESET di Koda)
  // === FIX 2026-07-02 (Fabio) — Rimosso ai_avatar (dead feature) ===
  // Nessuna UI lo settava, il componente Bubble non lo usava. Rimosso
  // per evitare bloating del profilo se in futuro qualche client
  // provasse a re-introdurlo con base64.
  bubble_color?: string;            // "viola" | "verde_acqua" | "rosa" | "ambra" | "ghiaccio" | hex
  bubble_style?: "glass" | "solid"; // visual style applied to BOTH user and AI bubbles
  text_size?: number;               // 0.85 | 1.0 | 1.15 | 1.35
  // === Proactive Check-in (Coda reaches out without you asking) ===
  checkin_mode?: "off" | "morning" | "evening" | "both";
  checkin_morning_time?: string;    // local "HH:MM" e.g. "08:30"
  checkin_evening_time?: string;    // local "HH:MM" e.g. "21:30"
};

// === BLOCCO A (2026-08-25) — CheckinResponse RIMOSSO ===================
// Nessun check-in proattivo generato dal backend.

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
  // === Freemium counter (giugno 2026)
  free_messages_used?: number;
  subscription_active?: boolean;
  subscription_tier?: "essential" | "daily" | "plus" | null;
  subscription_expires_at?: string | null;
  settings: ProfileSettings;
  memory_summary: string;
  created_at: string;
  updated_at: string;
};

export type FreemiumStatus = {
  free_messages_used: number;
  free_messages_limit: number;
  free_messages_remaining: number;
  subscription_active: boolean;
  subscription_tier: "essential" | "daily" | "plus" | null;
  can_send: boolean;
  paywall_required: boolean;
};

export type SafetyResource = {
  label: string;
  number: string;
  note?: string | null;
};

export type SafetyCheckResult = {
  risk_detected: boolean;
  risk_level: 0 | 1 | 2 | 3;
  category: "suicide" | "selfharm" | "domestic" | "minor" | "general_crisis" | null;
  detection_source: "regex" | "llm" | "both" | null;
  resources: SafetyResource[];
  advisory_message: string | null;
};

import { getAuthToken } from "./authToken";

async function jsonReq<T>(path: string, init?: RequestInit): Promise<T> {
  const __authTok = getAuthToken();
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(__authTok ? { Authorization: `Bearer ${__authTok}` } : {}),
      ...(init?.headers || {}),
    },
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

  /** Salva la città dell'utente come key_fact (one-shot al boot — P2 Fabio 2026-06-20). */
  postLocationContext: (payload: { city: string; region?: string; country?: string }) =>
    jsonReq<{ ok: boolean; city?: string; fact?: string; error?: string }>("/profile/location-context", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

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

  // === INTRO-V2 (conversational onboarding) ===
  /** Deduzione del genere dell'utente a partire dal nome parlato.
   *  Chiamato UNA volta durante /intro-v2. Il backend usa Claude Haiku
   *  (via Emergent LLM Key). Se il nome è ambiguo, il client mostra la
   *  domanda vocale ask_gender come fallback. */
  introGenderFromName: (name: string) =>
    jsonReq<{ gender: "m" | "f" | "ambiguous"; confidence: number }>(
      "/intro/gender-from-name",
      { method: "POST", body: JSON.stringify({ name }) }
    ),

  listVoices: () =>
    jsonReq<{ voices: VoiceOption[]; enabled: boolean }>("/voices"),

  /** generateCheckin — RIMOSSO (Blocco A, no needy Koda). L'endpoint
   *  /checkin/generate non esiste più nel backend. */

  /** Confessionale API — RIMOSSO (Blocco B, feature deprecata).
   *  Gli endpoint /confessional/history, /confessional/count e
   *  /confessional/reset non esistono più nel backend. */

  // === Auth (Block C) ===
  authMe: () => jsonReq<{ email: string; provider?: string }>("/auth/me"),
  authDevLogin: () =>
    jsonReq<{ email: string; name?: string; session_token: string }>(
      "/auth/dev-login",
      { method: "POST" }
    ),
  authGoogleSession: (sessionId: string) =>
    jsonReq<{ email: string; name?: string; picture?: string; session_token: string }>(
      "/auth/google/session",
      { method: "POST", headers: { "X-Session-ID": sessionId } }
    ),
  authApple: (identity_token: string, email?: string, full_name?: string) =>
    jsonReq<{ email: string; session_token: string }>("/auth/apple", {
      method: "POST",
      body: JSON.stringify({ identity_token, email, full_name }),
    }),
  authLogout: () => jsonReq<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  // === SITUATION TRACKING (V3.1 — Fabio 2026-08-22) ==================
  // Flat semantic ledger (no psychological profiling). Ogni chiamata
  // richiede opt-in ON lato server (except getStatus e wipe).
  situationsStatus: () =>
    jsonReq<{ enabled: boolean; count: number }>("/situations/status"),
  situationsList: (opts?: { limit?: number; includeArchived?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.includeArchived) params.set("include_archived", "true");
    const qs = params.toString();
    return jsonReq<{
      situations: Array<{
        id: string;
        entity_type: "person" | "topic" | "situation" | string;
        title: string;
        tags: string[];
        evidence_count: number;
        first_evidence_at: string;
        last_evidence_at: string;
        user_muted?: boolean;
        archived_at?: string | null;
      }>;
      count: number;
      enabled: boolean;
    }>(`/situations${qs ? "?" + qs : ""}`);
  },
  situationGet: (id: string, evidenceLimit = 20) =>
    jsonReq<{
      situation: {
        id: string;
        entity_type: string;
        title: string;
        tags: string[];
        evidence_count: number;
        first_evidence_at: string;
        last_evidence_at: string;
        user_muted?: boolean;
        archived_at?: string | null;
      };
      evidences: Array<{
        id: string;
        situation_id: string;
        observed_at: string;
        excerpt?: string | null;
        source: string;
      }>;
    }>(`/situations/${id}?evidence_limit=${evidenceLimit}`),
  situationPatch: (id: string, patch: { user_muted?: boolean; archived?: boolean }) =>
    jsonReq<{ ok: boolean; updated: boolean; changes?: unknown }>(`/situations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  situationDelete: (id: string) =>
    jsonReq<{ ok: boolean; evidences_deleted: number }>(`/situations/${id}`, {
      method: "DELETE",
    }),
  situationsWipe: () =>
    jsonReq<{ ok: boolean; situations_deleted: number; evidences_deleted: number }>(
      "/situations/wipe",
      { method: "POST" }
    ),

  // === ADMIN — Whitelist unlimited (2026-07-24) ===
  // Endpoint accessibili SOLO all'owner (Fabio). Il frontend chiama
  // adminWhoAmI() al boot per capire se mostrare il mini-panel in
  // Impostazioni; is_admin=false per utenti normali.
  adminWhoAmI: () =>
    jsonReq<{ is_admin: boolean; uid_short: string }>("/admin/whoami"),
  adminUnlimitedList: () =>
    jsonReq<
      Array<{
        email: string;
        uid: string;
        added_by: string;
        added_at: string;
        note?: string | null;
      }>
    >("/admin/unlimited/list"),
  adminUnlimitedAdd: (email: string, note?: string) =>
    jsonReq<{
      email: string;
      uid: string;
      added_by: string;
      added_at: string;
      note?: string | null;
    }>("/admin/unlimited/add", {
      method: "POST",
      body: JSON.stringify({ email, note }),
    }),
  adminUnlimitedRemove: (email: string) =>
    jsonReq<{ ok: boolean; removed: string }>(
      `/admin/unlimited/remove?email=${encodeURIComponent(email)}`,
      { method: "DELETE" }
    ),

  // === Block E ===
  analyticsTrack: (event: string, props?: Record<string, any>) =>
    jsonReq<{ ok: boolean }>("/analytics/track", {
      method: "POST",
      body: JSON.stringify({ event, props }),
    }),
  // === BLOCCO A (2026-08-25) — decisionHeartbeat / decisionFeedback RIMOSSI ==
  // Endpoint /decision/heartbeat e /decision/feedback rimossi dal backend
  // insieme al Decision Engine proattivo. Nessun re-engagement automatico.

  /** converseSealed — RIMOSSO (Blocco B, endpoint /converse/sealed cancellato). */

  /** Ricerca web pubblica (DuckDuckGo, no API key). */
  search: (query: string, max_results = 4) =>
    jsonReq<{ query: string; results: { title: string; snippet: string; url: string }[] }>(
      "/search",
      {
        method: "POST",
        body: JSON.stringify({ query, max_results }),
      }
    ),

  /** Ricordi semantici (long-term memory, giugno 2026).
   *  source ora è sempre "chat" (Confessionale rimosso in Blocco B). */
  listMemories: (limit = 50, source?: "chat") => {
    const q = source ? `?limit=${limit}&source=${source}` : `?limit=${limit}`;
    return jsonReq<{
      memories: Array<{
        id: string;
        concept: string;
        tags: string[];
        emotion?: string | null;
        importance: number;
        source: "chat";
        created_at: string;
      }>;
      count: number;
    }>(`/memories${q}`);
  },

  deleteMemory: (id: string) =>
    jsonReq<{ ok: boolean }>(`/memories/${id}`, { method: "DELETE" }),

  // === FREEMIUM "BLINDATO" 3 messaggi (giugno 2026) ==========================
  /** Stato corrente del freemium counter. Chiamato al boot e dopo ogni
   * risposta di Koda per aggiornare il contatore visivo (3 → 2 → 1 → 0). */
  freemiumStatus: () => jsonReq<FreemiumStatus>("/freemium/status"),

  /** === TRIAL STATE (2026-08-10, aggiornato 2026-08-11 con dev_override) ===
   * Ritorna l'enum "active" | "closing" | "expired" — nessun numero,
   * nessun prezzo, nessun nome piano. `dev_override` è true solo se
   * l'admin ha attivato manualmente uno stato via /api/dev/trial/seed-*
   * (usato dalla UI per abilitare l'uscita dal loop di test).
   * Consumato dal <TrialWatcher> in polling ogni 30s.
   * Utenti paid/unlimited ricevono sempre "active" (a meno di dev_override). */
  getTrialState: () =>
    jsonReq<{ trial_state: "active" | "closing" | "expired"; dev_override?: boolean }>("/trial/state"),

  /** === LASCIA ANDARE AUTHORIZATION (2026-08-12) ===
   * Fonte di verità server-side per l'accesso a Lascia Andare.
   * Chiamata SEMPRE prima di navigare e/o al mount della schermata.
   * Se il fetch fallisce (offline), il chiamante DEVE trattare come
   * denied (default-deny per policy). Non aprire varchi lato client. */
  authorizeLasciaAndare: () =>
    jsonReq<{ allowed: boolean; reason: string }>("/lascia-andare/authorize"),

  /** === LASCIA ANDARE — INTRO STATE (Fabio 2026-08-14) ===
   * Persistenza server-side del flag "primo accesso a Lascia Andare visto".
   * Sopravvive a reinstall/cambio device (a differenza di AsyncStorage). */
  getLasciaAndareIntroState: () =>
    jsonReq<{ seen: boolean; seen_at?: string | null }>(
      "/lascia-andare/intro-state"
    ),
  markLasciaAndareIntroSeen: () =>
    jsonReq<{ seen: boolean; seen_at?: string | null }>(
      "/lascia-andare/intro-seen",
      { method: "POST" }
    ),

  /** === INTRO PREMIUM — one-shot al primo boot home Koda conv (2026-08-22) ===
   * Persistenza server-side, sopravvive a reinstall/cambio device. */
  getIntroPremiumState: () =>
    jsonReq<{ seen: boolean; seen_at?: string | null }>("/intro-premium/state"),
  markIntroPremiumSeen: () =>
    jsonReq<{ seen: boolean; seen_at?: string | null }>(
      "/intro-premium/mark-seen",
      { method: "POST" }
    ),

  /** === DEV admin-only — testing Premium/Intro Premium senza terminale (2026-08-22) === */
  devSetTier: (tier: "monthly" | "bimonthly" | "annual" | "unlimited" | null) =>
    jsonReq<{ ok: boolean; profile_id: string; subscription_tier: string | null }>(
      "/dev/set-tier",
      { method: "POST", body: JSON.stringify({ tier }) }
    ),
  devIntroPremiumReset: () =>
    jsonReq<{ ok: boolean; profile_id: string; reset: string }>(
      "/dev/intro-premium/reset",
      { method: "POST" }
    ),
  /** DEV admin-only: reset COMPLETO onboarding server-side per rivedere
   *  l'intero flusso primo-boot (Fabio 2026-08-24). */
  devFirstBootReset: () =>
    jsonReq<{ ok: boolean; profile_id: string; reset: string[] }>(
      "/dev/first-boot/reset",
      { method: "POST" }
    ),

  /** === DEV TRIAL SEEDING (2026-08-11) — admin-only ===
   * Endpoint di test per manipolare lo stato del trial dell'utente admin
   * corrente senza consumare 7 minuti veri di TTS. Tutti restituiscono
   * lo stesso TrialSeedResponse con lo stato risultante. */
  devTrialSeedExpired: () =>
    jsonReq<any>("/dev/trial/seed-expired", { method: "POST" }),
  devTrialSeedClosing: () =>
    jsonReq<any>("/dev/trial/seed-closing", { method: "POST" }),
  devTrialSeedWindowExpired: () =>
    jsonReq<any>("/dev/trial/seed-window-expired", { method: "POST" }),
  devTrialReset: () =>
    jsonReq<any>("/dev/trial/reset", { method: "POST" }),
  devTrialInspect: () =>
    jsonReq<any>("/dev/trial/inspect"),

  /** Incrementa il counter messaggi gratis. Da chiamare DOPO un turno
   * completo (utente + Koda), MA SOLO se NON in Confessionale. */
  freemiumIncrement: () =>
    jsonReq<FreemiumStatus>("/freemium/increment", { method: "POST" }),

  /** DEV: resetta counter a 0. */
  freemiumReset: () =>
    jsonReq<{ ok: boolean }>("/freemium/reset", { method: "POST" }),

  // === SAFETY CHECK (doppio strato: regex + LLM Haiku) =======================
  /** Verifica safety PRIMA di mandare il messaggio a /converse.
   * Se risk_detected=true, il client deve:
   *   1. Bloccare l'invio normale
   *   2. Mostrare Eclissi in stato AMBRA
   *   3. Riprodurre advisory_message via TTS
   *   4. Mostrare le resources nella UI con numeri cliccabili */
  safetyCheck: (text: string, skip_llm: boolean = false) =>
    jsonReq<SafetyCheckResult>("/safety/check", {
      method: "POST",
      body: JSON.stringify({ text, skip_llm }),
    }),

  // === SUBSCRIPTION (RevenueCat) =============================================
  /** Sincronizza lo stato abbonamento dal client al backend. Chiamato dopo
   * successful purchase e al boot dopo Purchases.getCustomerInfo(). */
  subscriptionSync: (payload: {
    entitlement_active: boolean;
    tier?: "essential" | "daily" | "plus" | null;
    expires_at?: string | null;
    rc_app_user_id?: string;
  }) =>
    jsonReq<{ ok: boolean; subscription_active: boolean; subscription_tier: string | null }>(
      "/subscription/sync",
      { method: "POST", body: JSON.stringify(payload) }
    ),

  clearMemories: (source?: "chat") => {
    const q = source ? `?source=${source}` : "";
    return jsonReq<{ ok: boolean; deleted: number }>(`/memories${q}`, { method: "DELETE" });
  },

  /** confessionalDistill — RIMOSSO (Blocco B, endpoint /confessional/distill cancellato). */

  // === DISCLAIMER "Koda non è terapia" (Fabio 2026-07-28) ==================
  // Wrapper per l'overlay onboarding che chiarisce che Koda non sostituisce
  // un percorso professionale. `getDisclaimerStatus()` viene chiamato al
  // boot dell'app per capire se mostrare l'overlay blocking;
  // `acceptDisclaimer()` viene chiamato al tap "Ho capito" per registrare
  // timestamp + versione accettata sul profilo.
  getDisclaimerStatus: async (): Promise<{
    current_version: string;
    accepted_version: string | null;
    accepted_at: string | null;
    needs_acceptance: boolean;
  }> => {
    const r = await fetch(`${API_BASE}/legal/disclaimer/status`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  acceptDisclaimer: async (): Promise<{
    accepted_at: string;
    accepted_version: string;
  }> => {
    const r = await fetch(`${API_BASE}/legal/disclaimer/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    return r.json();
  },
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
