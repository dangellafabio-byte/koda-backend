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
 * Missing Inworld assets are explicit errors; no cross-provider fallback.
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
// Vento is unavailable under Inworld: getIntroAsset reports an error.
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
    const asset = INWORLD[key as keyof typeof INWORLD];
    if (asset !== undefined) return asset;
    console.error(`[TTS_ASSET_UNAVAILABLE] provider=inworld asset=${key}`);
    throw new Error(`Audio Inworld non disponibile: ${key}`);
  }
  return ELEVEN[key];
}

/**
 * Alias per `require()` dove serve l'oggetto asset in una variabile top-level.
 * Nota: NON è reattivo. Se il provider cambia a runtime, il componente deve
 * essere smontato/rimontato (es. router.replace("/intro-v3")).
 */
export const introAsset = getIntroAsset;
