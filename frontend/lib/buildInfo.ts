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
export const BUILD_VERSION = "2026-07-14 v1.0.113+11 (OTA project-id fix)";
export const BUILD_NOTES = "FIX CRITICO: projectId in app.json allineato a d022431b (project usato dalla build TestFlight). Prima era 92cf0b6f, causa root del fallimento consegna OTA. + Cielo viola, chip XL, backoff HF.";
