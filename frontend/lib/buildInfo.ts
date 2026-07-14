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
export const BUILD_VERSION = "2026-07-14 v1.0.113+8 (OTA color+chip fix)";
export const BUILD_NOTES = "Fix voce Cielo colore viola (era verde per fallback theme.primary). Fix chip 'Molto grande' → 'XL' + adjustsFontSizeToFit. Backend v27.";
