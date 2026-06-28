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
export const BUILD_VERSION = "2026-06-28 v1.1.0+28";
export const BUILD_NOTES = "FIX P0 Android: audio TTS non riprodotto (binary frame scartato per realm-mismatch ArrayBuffer) — ora gestisce TUTTI i tipi (ArrayBuffer cross-realm, Uint8Array, Blob, plain array). Plus pill Sfogo opaca.";
