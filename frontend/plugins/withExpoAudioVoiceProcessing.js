/**
 * Config Plugin Expo: attiva Voice Processing iOS su expo-audio.
 *
 * PROBLEMA: `expo-audio` hardcoda `mode: .default` su iOS in
 *   node_modules/expo-audio/ios/AudioModule.swift (~riga 578).
 * Senza override, `AVAudioSession` non attiva il Voice Processing
 * I/O Unit nativo iOS (AEC + NS + AGC — gli stessi filtri usati da
 * Siri, FaceTime, WhatsApp). Audio arriva al backend SPORCO.
 *
 * SOLUZIONE: durante `expo prebuild` (eseguito automaticamente da EAS
 * Build), questo plugin patcha il file Swift per usare `.voiceChat`
 * quando categoria è `.playAndRecord`.
 *
 * Idempotente: rilegge il file e applica la patch solo se non già
 * presente (marker "KODA PATCH"). Se una vecchia patch KODA di
 * versione diversa è presente, viene ripristinato l'OLD_BLOCK prima
 * di ri-applicare quello corrente.
 *
 * === STATO STABILE POST-ROLLBACK 2026-07-13 ===
 * Rimossa TUTTA la logica "Modalità Telefono" (earpiece/speaker toggle):
 *   • Nessun kodaSetAudioOutput / kodaGetAudioOutput AsyncFunction
 *   • Nessun override manuale via UserDefaults(KodaAudioOverrideMode)
 *   • Nessun proximity observer iOS/Android
 *   • Nessuna patch Android
 * Restano SOLO le modifiche minime necessarie al Voice Processing:
 *   • .voiceChat mode su .playAndRecord (per AEC/NS/AGC nativi Apple)
 *   • preferredSampleRate 16kHz + voice data source (mic Apple-like)
 *
 * Doc Apple: AVAudioSession.Mode.voiceChat richiede category
 *   .playAndRecord. Attiva Voice Processing AudioUnit a livello OS.
 */

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

const KODA_PATCH_MARKER = "KODA PATCH 2026-07-13 v56 (voiceChat mode only, rollback)";
// Marker generico per riconoscere QUALSIASI vecchia patch KODA v11..v55
// presente nel file cached di node_modules. Serve per revert automatico
// prima di applicare la versione corrente. NON modificare.
const KODA_GENERIC_IOS_MARKER = "KODA PATCH";

const OLD_BLOCK = `    if sessionOptions.isEmpty {
      try session.setCategory(category, mode: .default)
    } else {
      try session.setCategory(category, options: sessionOptions)
    }
  }`;

const NEW_BLOCK = `    if sessionOptions.isEmpty {
      // === ${KODA_PATCH_MARKER} ===
      // Voice Processing (AEC/NS/AGC) tramite AVAudioSession.Mode.voiceChat.
      // Stesso preset usato da Siri/FaceTime/WhatsApp. Pulisce rumore
      // motore/vento mantenendo la voce. Applicato SOLO per .playAndRecord.
      let recordingMode: AVAudioSession.Mode = (category == .playAndRecord) ? .voiceChat : .default
      try session.setCategory(category, mode: recordingMode)
      if category == .playAndRecord {
        // Configurazione mic Apple-like: 16kHz + Voice data source per
        // beamforming/noise reduction attivi.
        try? session.setPreferredSampleRate(16000)
        if let input = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
          if let voiceSource = input.dataSources?.first(where: {
            let n = $0.dataSourceName.lowercased()
            return n.contains("voice") || n.contains("front")
          }) {
            try? input.setPreferredDataSource(voiceSource)
          }
          try? session.setPreferredInput(input)
        }
      }
    } else {
      // === ${KODA_PATCH_MARKER} (ramo options) ===
      let recordingMode: AVAudioSession.Mode = (category == .playAndRecord) ? .voiceChat : .default
      try session.setCategory(category, mode: recordingMode, options: sessionOptions)
      if category == .playAndRecord {
        try? session.setPreferredSampleRate(16000)
        if let input = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
          if let voiceSource = input.dataSources?.first(where: {
            let n = $0.dataSourceName.lowercased()
            return n.contains("voice") || n.contains("front")
          }) {
            try? input.setPreferredDataSource(voiceSource)
          }
          try? session.setPreferredInput(input)
        }
      }
    }
  }`;

function revertPreviousKodaIosPatch(content) {
  // Se il file non contiene alcuna patch KODA, nulla da revertire.
  if (!content.includes(KODA_GENERIC_IOS_MARKER)) return content;
  // Se la patch corrente è già applicata, saltiamo.
  if (content.includes(KODA_PATCH_MARKER)) return content;
  // Trovato marker KODA di versione precedente → reverto il blocco setCategory
  // alla forma originale espo-audio (OLD_BLOCK), così la patch nuova si applica
  // normalmente sotto. Serve a bypassare la cache di node_modules su EAS Build
  // quando un vecchio bundle già patchato viene riutilizzato.
  const startAnchor = "    if sessionOptions.isEmpty {";
  const endAnchor = "\n  private func activateSession()";
  const startIdx = content.indexOf(startAnchor);
  const endIdx = content.indexOf(endAnchor, startIdx);
  if (startIdx === -1 || endIdx === -1) {
    console.warn(
      "[withExpoAudioVoiceProcessing] Revert: anchors non trovati in AudioModule.swift. " +
        "Impossibile ripulire la patch precedente. La patch nuova potrebbe NON applicarsi."
    );
    return content;
  }
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx);
  const reverted = before + OLD_BLOCK + "\n" + after;
  console.log(
    "[withExpoAudioVoiceProcessing] ♻️  Patch KODA di versione precedente rilevata → " +
      "ripristino OLD_BLOCK prima di applicare " + KODA_PATCH_MARKER
  );
  return reverted;
}

// ============================================================================
// CLEANUP legacy AsyncFunction injections (kodaSetAudioOutput/kodaGetAudioOutput)
// ============================================================================
// Se un vecchio bundle node_modules su EAS Build contiene ancora l'iniezione
// KODA_V*_ASYNC_FUNCTION (dalle build v50-v55), la rimuoviamo. Non iniettiamo
// nulla al suo posto — la feature "Modalità Telefono" è stata rimossa.
function removeLegacyAsyncFunctions(projectRoot) {
  const file = path.join(
    projectRoot,
    "node_modules",
    "expo-audio",
    "ios",
    "AudioModule.swift"
  );
  if (!fs.existsSync(file)) return;
  let content = fs.readFileSync(file, "utf8");
  const OLD_ASYNC_MARKERS = [
    "// === KODA_V17_ASYNC_FUNCTION",
    "// === KODA_V18_ASYNC_FUNCTION",
    "// === KODA_V19_ASYNC_FUNCTION",
    "// === KODA_V20_ASYNC_FUNCTION",
    "// === KODA_V21_ASYNC_FUNCTION",
    "// === KODA_V22_ASYNC_FUNCTION",
  ];
  let changed = false;
  for (const marker of OLD_ASYNC_MARKERS) {
    if (!content.includes(marker)) continue;
    const startAnchor = "    " + marker;
    const endAnchor = "    OnDestroy {";
    const s = content.indexOf(startAnchor);
    const e = content.indexOf(endAnchor, s);
    if (s !== -1 && e !== -1) {
      content = content.slice(0, s) + content.slice(e);
      changed = true;
      console.log(
        "[withExpoAudioVoiceProcessing][iOS] ♻️  Legacy AsyncFunction removed (" + marker + ")."
      );
    }
  }
  if (changed) fs.writeFileSync(file, content, "utf8");
}

// ============================================================================
// CLEANUP legacy Android patch
// ============================================================================
// Se un vecchio bundle node_modules su EAS Build contiene ancora la patch
// KODA_ANDROID_MARKER (proximity sensor auto-routing), la lasciamo com'è ma
// non applichiamo nuove patch. In prossime pulizie, valutare revert completo.
// Per il rollback attuale è sufficiente: la patch Android non è collegata
// a nessuna chiamata JS.

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

  const reverted = revertPreviousKodaIosPatch(content);
  if (reverted !== content) {
    fs.writeFileSync(file, reverted, "utf8");
    content = reverted;
  }

  if (content.includes(KODA_PATCH_MARKER)) {
    console.log(
      "[withExpoAudioVoiceProcessing] Patch already applied (marker found). Skipping."
    );
    return;
  }

  if (!content.includes(OLD_BLOCK)) {
    console.warn(
      "[withExpoAudioVoiceProcessing] Source block not found in AudioModule.swift. " +
        "expo-audio version may have changed. Voice Processing NOT activated."
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
  // iOS: patch AudioModule.swift for voiceChat mode. Cleanup legacy AsyncFunc.
  config = withDangerousMod(config, [
    "ios",
    async (config) => {
      removeLegacyAsyncFunctions(config.modRequest.projectRoot);
      patchExpoAudioSwift(config.modRequest.projectRoot);
      return config;
    },
  ]);
  // Android: nessuna patch applicata (Modalità Telefono rimossa).
  return config;
};
