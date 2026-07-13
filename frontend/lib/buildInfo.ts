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
export const BUILD_VERSION = "2026-07-13 v1.1.0+59 (OTA-fix)";
export const BUILD_NOTES = "OTA fix: runtimeVersion ripristinato a '1.1.0' (stringa fissa) per allineamento con build v56. Voce Cielo + UI Impostazioni ridisegnate. Backend v27.";
