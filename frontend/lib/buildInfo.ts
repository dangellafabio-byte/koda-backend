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
export const BUILD_VERSION = "2026-07-14 v1.0.113+9 (OTA color+chip+backoff)";
export const BUILD_NOTES = "Fix voce Cielo colore viola. Fix chip 'XL'. Fix loop HF: backoff dopo 3 WS fail consecutivi → messaggio 'Connessione persa. Tocca per riprovare' (non martella più il backend). Backend v27.";
