/**
 * Build Info — identificatore univoco del bundle JS attualmente in uso.
 *
 * ⚠️  QUESTA STRINGA È HARDCODED. Non viene auto-generata dal build.
 * Aggiornarla A MANO ad ogni modifica significativa prima di premere
 * "Save to GitHub" + "Publish → Genera build iOS".
 *
 * Visibile in fondo alle Impostazioni dell'app, in caratteri piccoli.
 *
 * Formato: "YYYY-MM-DD v<app.version>+<changeset> (descrizione)".
 */
export const BUILD_VERSION = "2026-07-20 v1.0.113+16 (KODA_BUILDTAG aggiornato + plugin loud-fail)";

export const BUILD_NOTES =
  "Se questa card Diagnostica mostra Mode=AVAudioSessionModeVoiceChat verde, " +
  "il plugin nativo è nel binario e il noise cancellation Apple è attivo. " +
  "Include: anchor fix v63.3 multipli con fallback + loud-fail v63.4 " +
  "(EAS build fallisce esplicitamente se plugin non si applica). " +
  "KODA_BUILDTAG allineato a build=2026-07-20.";
