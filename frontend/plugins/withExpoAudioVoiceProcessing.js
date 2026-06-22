/**
 * Config Plugin Expo: attiva Voice Processing iOS su expo-audio.
 *
 * PROBLEMA: `expo-audio` v1.1.1 hardcoda `mode: .default` su iOS in
 *   node_modules/expo-audio/ios/AudioModule.swift riga ~578.
 * Senza override, `AVAudioSession` non attiva il Voice Processing
 * I/O Unit nativo iOS (AEC + NS + AGC — gli stessi filtri usati da
 * Siri, FaceTime, WhatsApp). Audio arriva al backend SPORCO.
 *
 * SOLUZIONE: durante `expo prebuild` (eseguito automaticamente da EAS
 * Build), questo plugin patcha il file Swift in node_modules per usare
 * `.voiceChat` quando categoria è `.playAndRecord`. La modifica viene
 * poi compilata da CocoaPods nel binario iOS finale.
 *
 * Perché Config Plugin invece di solo patch-package?
 *   - patch-package dipende dall'hook `postinstall` di yarn. Alcuni
 *     pipeline EAS eseguono `yarn install --ignore-scripts` per
 *     sicurezza, saltando il postinstall → patch non si applica.
 *   - Questo Config Plugin gira DENTRO `expo prebuild`, che EAS Build
 *     esegue SEMPRE come parte del suo flusso ufficiale.
 *   - Idempotente: rilegge il file e applica la patch solo se non già
 *     presente (marker "KODA PATCH"). Coesiste con patch-package.
 *
 * Doc Apple: AVAudioSession.Mode.voiceChat richiede category
 *   .playAndRecord. Attiva Voice Processing AudioUnit a livello OS.
 */

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

const KODA_PATCH_MARKER = "KODA PATCH 2026-06-22 v11 (Voice Processing + speaker route)";

const OLD_BLOCK = `    if sessionOptions.isEmpty {
      try session.setCategory(category, mode: .default)
    } else {
      try session.setCategory(category, options: sessionOptions)
    }
  }`;

const NEW_BLOCK = `    if sessionOptions.isEmpty {
      // === ${KODA_PATCH_MARKER} ===
      // Quando si registra, usa .voiceChat invece di .default per attivare
      // l'AudioUnit Voice Processing nativo iOS (AEC + NS + AGC). Stesso
      // preset usato da Siri/FaceTime/WhatsApp. Pulisce automaticamente
      // rumore motore furgone/vento, mantiene la voce. Solo .playAndRecord
      // supporta .voiceChat → fallback a .default per le altre categorie.
      let recordingMode: AVAudioSession.Mode = (category == .playAndRecord) ? .voiceChat : .default
      try session.setCategory(category, mode: recordingMode)
      // === KODA v11 FIX (2026-06-22): routing audio allo SPEAKER ===
      // .voiceChat di default routa l'output all'EARPIECE (auricolare in
      // alto, come una chiamata vocale). Per sentire Koda dallo speaker
      // grande senza il telefono all'orecchio, forziamo overrideOutputAudioPort.
      // .defaultToSpeaker option non basta con .voiceChat — serve l'override.
      if category == .playAndRecord {
        try? session.overrideOutputAudioPort(.speaker)
      }
    } else {
      // === ${KODA_PATCH_MARKER} (ramo options) ===
      let recordingMode: AVAudioSession.Mode = (category == .playAndRecord) ? .voiceChat : .default
      try session.setCategory(category, mode: recordingMode, options: sessionOptions)
      if category == .playAndRecord {
        try? session.overrideOutputAudioPort(.speaker)
      }
    }
  }`;

function patchExpoAudioSwift(projectRoot) {
  const file = path.join(
    projectRoot,
    "node_modules",
    "expo-audio",
    "ios",
    "AudioModule.swift"
  );

  if (!fs.existsSync(file)) {
    console.warn(
      `[withExpoAudioVoiceProcessing] AudioModule.swift NOT FOUND at ${file}. ` +
        "Skipping patch. expo-audio may not be installed or may have a different layout."
    );
    return;
  }

  let content = fs.readFileSync(file, "utf8");

  if (content.includes(KODA_PATCH_MARKER)) {
    console.log(
      "[withExpoAudioVoiceProcessing] Patch already applied (marker found). Skipping."
    );
    return;
  }

  if (!content.includes(OLD_BLOCK)) {
    console.warn(
      "[withExpoAudioVoiceProcessing] Source block not found in AudioModule.swift. " +
        "expo-audio version may have changed. Voice Processing NOT activated. " +
        "Review node_modules/expo-audio/ios/AudioModule.swift line ~578."
    );
    return;
  }

  const patched = content.replace(OLD_BLOCK, NEW_BLOCK);
  fs.writeFileSync(file, patched, "utf8");
  console.log(
    "[withExpoAudioVoiceProcessing] ✅ Voice Processing patch applied to expo-audio AudioModule.swift"
  );
}

module.exports = function withExpoAudioVoiceProcessing(config) {
  return withDangerousMod(config, [
    "ios",
    async (config) => {
      patchExpoAudioSwift(config.modRequest.projectRoot);
      return config;
    },
  ]);
};
