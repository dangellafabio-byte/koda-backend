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
export const BUILD_VERSION = "2026-07-08 v1.1.0+46";
export const BUILD_NOTES = "Tap durante recording = graceful stop (Koda risponde). Long-press 500ms = kill-switch privacy. Proximity sensor auto-routing (iOS+Android). Settings modal ottimizzata (removeClippedSubviews, lazy mount).";
