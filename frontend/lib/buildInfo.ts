/**
 * Build Info — identificatore univoco del bundle JS attualmente in uso.
 *
 * ⚠️  QUESTA STRINGA È HARDCODED. Non viene auto-generata dal build.
 */
export const BUILD_VERSION = "2026-07-20 v1.0.113+18 (REVERT TOTALE JS al 17 lug — recorder ripristinato)";

export const BUILD_NOTES =
  "Rimosse TUTTE le modifiche JS del 19-20 luglio che toccavano il flow audio: " +
  "no più kodaGetAudioSessionState, no piggyback WS query params, no card AVAudioSession. " +
  "voice.ts / voiceStream.ts / diagnostics.tsx tornati ESATTAMENTE identici al 17 lug " +
  "(commit c070a661) — l'unica differenza è che backend punta a Railway invece che a Emergent. " +
  "Se il recorder funziona con questo bundle, il colpevole della regressione era mio.";
