/**
 * sentry.ts — Inizializzazione Sentry per Koda / L'Amico Fraterno
 *
 * Region: EU (Frankfurt) — enforced dal DSN dell'organizzazione EU.
 * Session Replay: DISATTIVATO al lancio (privacy). Riconsiderare dopo 2-4 settimane.
 * Sample rates: errori 100%, performance 20%.
 *
 * Env vars richieste:
 *   EXPO_PUBLIC_SENTRY_DSN — public DSN progetto koda-mobile
 *
 * Chiamare initSentry() UNA SOLA VOLTA in app/_layout.tsx PRIMA di qualsiasi render.
 */

import * as Sentry from "@sentry/react-native";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { scrubEventForPrivacy, scrubBreadcrumbForPrivacy } from "./sentryPrivacy";

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || "";

/**
 * Rileva se stiamo girando in Expo Go (SDK 50+).
 * Alcune feature (native frames, initial display) richiedono dev/prod build.
 */
function isRunningInExpoGo(): boolean {
  return Constants.appOwnership === "expo";
}

let _sentryInitialized = false;

export function initSentry(): void {
  if (_sentryInitialized) {
    return;
  }

  if (!SENTRY_DSN) {
    // In dev senza DSN, evita di crashare — logga solo
    // eslint-disable-next-line no-console
    console.warn(
      "[Sentry] EXPO_PUBLIC_SENTRY_DSN non impostato — crash reporting DISABILITATO"
    );
    return;
  }

  try {
    Sentry.init({
      dsn: SENTRY_DSN,

      // === Privacy: NIENTE PII automatico ===
      sendDefaultPii: false,

      // === Sampling ===
      sampleRate: 1.0,          // 100% errori
      tracesSampleRate: 0.2,    // 20% performance

      // === Release info (per matching source maps + aggregazione) ===
      release: `${(Constants.expoConfig?.slug || "koda")}@${
        Constants.expoConfig?.version || "unknown"
      }`,
      dist: String(
        Platform.OS === "ios"
          ? Constants.expoConfig?.ios?.buildNumber || "0"
          : Constants.expoConfig?.android?.versionCode || 0
      ),

      // === Environment tag ===
      environment: __DEV__ ? "development" : "production",

      // === Integrations ===
      // - reactNativeTracingIntegration: navigation + performance tracing (auto per expo-router)
      // - Nota: expoRouterIntegration dedicata non è disponibile in v7.2.0,
      //   ma reactNativeTracingIntegration copre le transazioni di navigazione base.
      integrations: [
        Sentry.reactNativeTracingIntegration(),
      ],

      // === Native frames tracking (solo su dev/prod build, non Expo Go) ===
      enableNativeFramesTracking: !isRunningInExpoGo(),

      // === App hang tracking (solo dev/prod build) ===
      enableAppHangTracking: !isRunningInExpoGo(),

      // === Privacy hooks — CRITICI ===
      beforeSend: (event, hint) => scrubEventForPrivacy(event, hint),
      beforeBreadcrumb: (breadcrumb, hint) =>
        scrubBreadcrumbForPrivacy(breadcrumb, hint),

      // === Debug (solo in dev per non spammare production) ===
      debug: __DEV__,

      // === Ignora errori "attesi" ===
      ignoreErrors: [
        // Errori di rete transitori — non actionable
        "Network request failed",
        "AbortError",
        // WebSocket close normale
        "WebSocket connection closed",
      ],
    });

    // Tag globali di sessione — coarse metadata, no PII
    Sentry.setTag("platform", Platform.OS);
    Sentry.setTag("app_version", Constants.expoConfig?.version || "unknown");
    Sentry.setTag(
      "build_number",
      Platform.OS === "ios"
        ? String(Constants.expoConfig?.ios?.buildNumber || "0")
        : String(Constants.expoConfig?.android?.versionCode || 0)
    );
    Sentry.setTag(
      "expo_go",
      isRunningInExpoGo() ? "true" : "false"
    );

    _sentryInitialized = true;
    // eslint-disable-next-line no-console
    console.log("[Sentry] initialized ✓");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[Sentry] init failed:", err);
  }
}

/**
 * Imposta contesto utente ANONIMIZZATO (hashed ID).
 * MAI passare email/username plaintext. Chiamare all'onboarding/login.
 */
export function setSentryUser(
  hashedProfileId: string | null,
  extra?: {
    subscription_tier?: string;
    stt_engine?: string;
    hands_free?: boolean;
    audio_route?: string;
  }
): void {
  if (!_sentryInitialized) return;
  try {
    if (hashedProfileId) {
      Sentry.setUser({ id: hashedProfileId });
    } else {
      Sentry.setUser(null);
    }
    if (extra?.subscription_tier) {
      Sentry.setTag("subscription_tier", extra.subscription_tier);
    }
    if (extra?.stt_engine) {
      Sentry.setTag("stt_engine", extra.stt_engine);
    }
    if (typeof extra?.hands_free === "boolean") {
      Sentry.setTag("hands_free", String(extra.hands_free));
    }
    if (extra?.audio_route) {
      Sentry.setTag("audio_route", extra.audio_route);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[Sentry] setSentryUser failed:", err);
  }
}

/**
 * Aggiorna tag di sessione dinamicamente (STT engine, audio route, hands-free).
 * Utile quando l'utente cambia device/output audio a runtime.
 */
export function updateSentrySessionTags(
  tags: Record<string, string | number | boolean>
): void {
  if (!_sentryInitialized) return;
  try {
    for (const [key, value] of Object.entries(tags)) {
      Sentry.setTag(key, String(value));
    }
  } catch {
    // silent
  }
}

/**
 * Cattura eccezione con contesto aggiuntivo (safe, viene comunque scrubbato).
 */
export function captureKodaError(
  error: unknown,
  context?: { category?: string; extra?: Record<string, any> }
): void {
  if (!_sentryInitialized) return;
  try {
    Sentry.withScope((scope) => {
      if (context?.category) {
        scope.setTag("koda_error_category", context.category);
      }
      if (context?.extra) {
        scope.setContext("koda_context", context.extra);
      }
      Sentry.captureException(error);
    });
  } catch {
    // silent
  }
}

/**
 * Test intenzionale — chiamare da un bottone dev per verificare che Sentry funzioni.
 */
export function triggerSentryTestError(): void {
  throw new Error("Koda Sentry test error — this is intentional");
}

// Ri-esporta Sentry per chiamate avanzate dai singoli moduli
export { Sentry };
