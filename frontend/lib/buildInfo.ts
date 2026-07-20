/**
 * Build Info — identificatore univoco del bundle JS attualmente in uso.
 *
 * ⚠️  QUESTA STRINGA È HARDCODED. Non viene auto-generata dal build.
 * Aggiornarla A MANO ad ogni modifica significativa prima di premere
 * "Publish → Genera build iOS". Serve SOLO a mostrare in-app quale
 * codice sorgente ha compilato il binario, così l'utente può capire
 * al volo se la build è fresca o vecchia.
 *
 * Visibile in fondo alle Impostazioni dell'app, in caratteri piccoli.
 *
 * Formato: "YYYY-MM-DD v<app.version>+<changeset> (descrizione)".
 */
export const BUILD_VERSION = "2026-07-20 v1.0.113+15 (plugin loud-fail + anchor fix definitivo)";

export const BUILD_NOTES =
  "FIX DEFINITIVO PLUGIN: anchor kodaGetAudioSessionState multipli con fallback " +
  "(setAudioModeAsync / setIsAudioActiveAsync / setAudioMode). " +
  "Loud-fail se il patch non si applica → build EAS fallisce esplicitamente " +
  "invece di produrre un binario silenziosamente rotto. Log verbose in prebuild " +
  "per debug futuro. Se questa card mostra .voiceChat verde ✅ → tutto ok.";
