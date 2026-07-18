/**
 * KODA — Backend URL (Piano B, hardcoded 2026-07-19)
 * ===================================================
 *
 * === MIGRAZIONE EMERGENT → RAILWAY (Fabio, 18/19-07-2026) ===
 *
 * Il file /app/frontend/.env viene RIPRISTINATO automaticamente dal sistema
 * Emergent quando si modifica EXPO_PUBLIC_BACKEND_URL (osservato 3 volte
 * di fila, timestamp 22:10 → 23:00 → 23:something). Questo impedisce di
 * far puntare le build EAS a Railway usando la variabile d'ambiente.
 *
 * SOLUZIONE ROBUSTA: hardcoded nel codice sorgente. Emergent NON tocca il
 * codice .ts, quindi la variabile qui sotto è persistente attraverso
 * qualsiasi ripristino/riavvio della piattaforma.
 *
 * REGOLA: TUTTE le chiamate al backend (fetch REST + WebSocket) devono
 * usare `KODA_BACKEND_URL` importato da qui. NON leggere direttamente
 * `process.env.EXPO_PUBLIC_BACKEND_URL` da nessuna altra parte.
 *
 * SE VUOI CAMBIARE BACKEND (es. tornare a Emergent, o migrare altrove):
 *   1. Cambia la costante qui sotto
 *   2. Rebuild + Publish per generare nuova TestFlight/APK
 *   3. Fine.
 */

// === Backend hardcoded — Railway ==============================
// Verificato online e responsive il 2026-07-19 (WS ready, /api ok).
// NON toccare senza aver testato prima con:
//   curl https://<new-url>/api/  → deve rispondere 200 con status:ok
export const KODA_BACKEND_URL =
  "https://koda-backend-production-4a34.up.railway.app";

/**
 * Costruisce l'URL WebSocket per l'endpoint /api/voice/stream.
 * Fa la sostituzione http(s):// → ws(s):// e appende il path.
 */
export function kodaBackendWsUrl(path: string = "/api/voice/stream"): string {
  const base = KODA_BACKEND_URL.replace(/^http/i, "ws").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Costruisce un URL HTTP per un path REST.
 */
export function kodaBackendHttpUrl(path: string): string {
  const base = KODA_BACKEND_URL.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
