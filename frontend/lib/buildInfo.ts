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
export const BUILD_VERSION = "2026-07-20 v1.0.113+14 (v63.3 anchor fix — plugin injection ripristinata)";

export const BUILD_NOTES =
  "FIX CRITICO PLUGIN: anchor kodaGetAudioSessionState era `Function(\"setAudioMode\"` " +
  "ma in expo-audio 1.1.1 la funzione si chiama `AsyncFunction(\"setAudioModeAsync\")`. " +
  "L'injection falliva silenziosamente → la card Diagnostica mostrava 'plugin v63 NOT AVAILABLE'. " +
  "Ora anchor multipli con fallback. La patch .voiceChat era già attiva; ora anche il runtime check funziona.";
