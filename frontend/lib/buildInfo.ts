/**
 * Build Info — identificatore univoco del bundle JS attualmente in uso.
 *
 * ⚠️  QUESTA STRINGA È HARDCODED. Non viene auto-generata dal build.
 * Aggiornarla A MANO ad ogni modifica significativa prima di premere
 * "Save to GitHub" (l'OTA workflow triggera l'update automatico dopo il push).
 *
 * Visibile in fondo alle Impostazioni dell'app, in caratteri piccoli.
 *
 * Formato: "YYYY-MM-DD v<app.version>+<changeset> (descrizione)".
 */
export const BUILD_VERSION = "2026-07-20 v1.0.113+17 (ROLLBACK JS: kodaGetAudioSessionState fuori da prewarmMic)";

export const BUILD_NOTES =
  "FIX REGRESSIONE v1.0.133: la chiamata a kodaGetAudioSessionState() dentro " +
  "prewarmMic causava Session activation failed x5 → BAIL OUT del recorder. " +
  "Il check runtime è ora ON-DEMAND solo dalla schermata Diagnostica. " +
  "Il flow di recording è tornato identico a v1.0.132 (funzionante). " +
  "Se ora prepareToRecordAsync riprende a funzionare, il colpevole era confermato.";
