/**
 * Build Info — identificatore univoco del bundle JS attualmente in uso.
 *
 * Aggiornare BUILD_VERSION ad OGNI modifica significativa di UI/logica
 * che l'utente deve poter verificare dopo il deployment.
 *
 * Visibile in fondo alle Impostazioni dell'app, in caratteri piccoli.
 * Permette di distinguere a colpo d'occhio se il device ha scaricato
 * il bundle aggiornato o se sta ancora usando una versione precedente.
 *
 * Formato: "YYYY-MM-DD HH:mm" + descrizione breve.
 */
export const BUILD_VERSION = "2026-07-13 v1.0.112+60 (OTA-fix-2)";
export const BUILD_NOTES = "OTA fix v2: runtimeVersion hardcoded a '1.0.112' (stringa fissa) — aveva policy dinamica che collideva con appVersionSource:remote in eas.json. Voce Cielo + UI Impostazioni. Backend v27.";
