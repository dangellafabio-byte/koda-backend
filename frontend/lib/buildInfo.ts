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
export const BUILD_VERSION = "2026-07-13 v1.1.0+57 (OTA)";
export const BUILD_NOTES = "UI Impostazioni ridisegnate: sezioni con chip accent, bottoni più grandi, spaziatura +respiro, testo hint più leggibile. Backend v26: memoria voce↔chat persistente MongoDB + adaptive endpointing Deepgram. Nessuna feature funzionale toccata.";
