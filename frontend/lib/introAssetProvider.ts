/**
 * introAssetProvider — Dispatch degli asset audio statici in base al
 * provider TTS attivo (ElevenLabs vs Inworld A/B dev).
 * ===================================================================
 *
 * Metro bundler richiede che `require()` sia una stringa statica literal
 * (non interpolata). Quindi NON possiamo fare `require(path)` dinamico:
 * mappiamo manualmente ogni asset ElevenLabs → variante Inworld.
 *
 * Il resolve del provider avviene via `readTTSProviderSync()` (sincrono,
 * usa la cache in-memory già idratata al boot in `_layout.tsx`).
 *
 * I 12 asset coperti sono stati rigenerati con Inworld TTS-2
 * voce `vivid-feather-7719__design-voice-37081da2`, it-IT, rate 1.05,
 * delivery CREATIVE. Testi identici alle versioni ElevenLabs
 * (verificati 2026-10 via trascrizione STT).
 *
 * Fallback: se una chiave non è coperta Inworld (es: file Vento maschile,
 * legacy V2), ritorniamo SEMPRE l'asset ElevenLabs — no silenzio.
 */
import { readTTSProviderSync } from "./ttsProviderClient";

// ===== ElevenLabs (default, bundle originale) =====
const ELEVEN = {
  // Intro
  intro_v3_parte_di_me: require("../assets/sounds/intro/intro_v3_parte_di_me-cielo.mp3"),
  intro_premium_eccomi: require("../assets/sounds/intro/intro_premium_eccomi-cielo.mp3"),
  intro_premium_closing: require("../assets/sounds/intro/intro_premium_closing-cielo.mp3"),
  reveal_cuore_voce: require("../assets/sounds/intro/reveal_cuore_voce-cielo.mp3"),
  // Lascia Andare — firstBoot
  la_cuore: require("../assets/sounds/intro/la_cuore-cielo.mp3"),
  la_provalo: require("../assets/sounds/intro/la_provalo-cielo.mp3"),
  // Microdemo
  microdemo_open: require("../assets/sounds/intro/microdemo_open-cielo.mp3"),
  microdemo_close: require("../assets/sounds/intro/microdemo_close-cielo.mp3"),
  // Paywall
  paywall_voce: require("../assets/sounds/intro/paywall_voce-cielo.mp3"),
  // Lascia Andare — rituale open/close (Cielo + Vento)
  la_open_cielo: require("../assets/sounds/lascia-andare/open-cielo.mp3"),
  la_close_cielo: require("../assets/sounds/lascia-andare/close-cielo.mp3"),
  la_open_vento: require("../assets/sounds/lascia-andare/open-vento.mp3"),
  la_close_vento: require("../assets/sounds/lascia-andare/close-vento.mp3"),
  // Quota exhausted
  quota_exhausted: require("../assets/audio/koda_quota_exhausted.mp3"),
};

// ===== Inworld A/B (dev, voce Cielo soltanto in fase 1) =====
// NOTA: le varianti Vento NON esistono in Inworld in questa fase.
// Se l'utente ha selezionato Vento mentre il provider è Inworld, i
// componenti chiamano la_open_vento / la_close_vento → qui ritorniamo
// l'asset ElevenLabs originale (NON silenzio): coerente con il contratto
// "Vento resta su ElevenLabs quando il resto va su Inworld, ma a livello
// endpoint runtime il backend blocca con 503". Per gli asset statici il
// fallback è trasparente (nessun endpoint da bloccare).
const INWORLD = {
  intro_v3_parte_di_me: require("../assets/sounds/intro-inworld/intro_v3_parte_di_me-cielo.mp3"),
  intro_premium_eccomi: require("../assets/sounds/intro-inworld/intro_premium_eccomi-cielo.mp3"),
  intro_premium_closing: require("../assets/sounds/intro-inworld/intro_premium_closing-cielo.mp3"),
  reveal_cuore_voce: require("../assets/sounds/intro-inworld/reveal_cuore_voce-cielo.mp3"),
  la_cuore: require("../assets/sounds/intro-inworld/la_cuore-cielo.mp3"),
  la_provalo: require("../assets/sounds/intro-inworld/la_provalo-cielo.mp3"),
  microdemo_open: require("../assets/sounds/intro-inworld/microdemo_open-cielo.mp3"),
  microdemo_close: require("../assets/sounds/intro-inworld/microdemo_close-cielo.mp3"),
  paywall_voce: require("../assets/sounds/intro-inworld/paywall_voce-cielo.mp3"),
  la_open_cielo: require("../assets/sounds/lascia-andare-inworld/open-cielo.mp3"),
  la_close_cielo: require("../assets/sounds/lascia-andare-inworld/close-cielo.mp3"),
  // Vento voci non disponibili in Inworld fase 1 → ricadiamo su ElevenLabs
  la_open_vento: ELEVEN.la_open_vento,
  la_close_vento: ELEVEN.la_close_vento,
  quota_exhausted: require("../assets/audio-inworld/koda_quota_exhausted.mp3"),
};

export type IntroAssetKey = keyof typeof ELEVEN;

/**
 * Risolve l'asset corretto per la chiave in base al provider attivo.
 * Chiamabile sincrono dal componente (idrata via `_layout.tsx` al boot).
 */
export function getIntroAsset(key: IntroAssetKey) {
  const provider = readTTSProviderSync();
  if (provider === "inworld") {
    const asset = INWORLD[key];
    if (asset !== undefined) return asset;
    // Chiave non coperta Inworld → fallback trasparente a ElevenLabs
    return ELEVEN[key];
  }
  return ELEVEN[key];
}

/**
 * Alias per `require()` dove serve l'oggetto asset in una variabile top-level.
 * Nota: NON è reattivo. Se il provider cambia a runtime, il componente deve
 * essere smontato/rimontato (es. router.replace("/intro-v3")).
 */
export const introAsset = getIntroAsset;
