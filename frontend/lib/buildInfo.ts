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
export const BUILD_VERSION = "2026-07-20 v1.0.113+13 (AVAudioSession diag card + WS piggyback)";

export const BUILD_NOTES =
  "Backend Railway + Bandpass 300-3400Hz + gain adattivo (server-side). " +
  "Plugin nativo iOS .voiceChat mode (AEC/NS/AGC Apple) + kodaGetAudioSessionState. " +
  "NEW: Diagnostica mostra stato AVAudioSession in card fissa + WS URL " +
  "trasporta mode/input/output così Railway logga tutto insieme a chunks/bytes.";
