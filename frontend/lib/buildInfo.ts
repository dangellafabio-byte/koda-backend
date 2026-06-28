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
export const BUILD_VERSION = "2026-06-28 v1.1.0+31";
export const BUILD_NOTES = "Android: chunk 1500→3000ms. Ridotti i cicli prepare/stop del mic (causa flash HyperOS + buchi audio Deepgram). Latenza +1.5s ma flusso voce affidabile.";
