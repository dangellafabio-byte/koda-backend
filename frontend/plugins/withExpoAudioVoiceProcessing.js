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
const KODA_ASYNC_FN_MARKER = "KODA_V63_ASYNC_AUDIO_MODE_QUERY";
// Marker generico per riconoscere QUALSIASI vecchia patch KODA v11..v55
// presente nel file cached di node_modules. Serve per revert automatico
// prima di applicare la versione corrente. NON modificare.
const KODA_GENERIC_IOS_MARKER = "KODA PATCH";

// === v63 2026-07-19 — Runtime audio mode query =====================
// AsyncFunction JS-callable che ritorna lo stato REALE di AVAudioSession
// al momento della chiamata: category, mode, sample_rate, input port.
// Necessario per verificare se la patch v56 (.voiceChat) è effettivamente
// attiva runtime — nessun altro modo di controllarlo da JS.
const ASYNC_FN_BLOCK = `    // === ${KODA_ASYNC_FN_MARKER} ===
    AsyncFunction("kodaGetAudioSessionState") { () -> [String: Any] in
      let session = AVAudioSession.sharedInstance()
      var result: [String: Any] = [:]
      result["category"] = session.category.rawValue
      result["mode"] = session.mode.rawValue
      result["sample_rate"] = session.sampleRate
      result["preferred_sample_rate"] = session.preferredSampleRate
      if let input = session.currentRoute.inputs.first {
        result["input_port_type"] = input.portType.rawValue
        result["input_port_name"] = input.portName
        if let ds = input.selectedDataSource {
          result["input_data_source"] = ds.dataSourceName
        } else {
          result["input_data_source"] = "none"
        }
      } else {
        result["input_port_type"] = "none"
      }
      if let output = session.currentRoute.outputs.first {
        result["output_port_type"] = output.portType.rawValue
      }
      return result
    }
`;

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

  // === v63.4 2026-07-20 — VERBOSE PRE-CHECK ===
  // Prima di tentare qualsiasi patch, logghiamo cosa vediamo nel file
  // così nei log EAS Build si vede subito se node_modules è stato
  // rigenerato correttamente o se abbiamo una cache stale.
  const swiftHead = content.substring(0, 500).replace(/\n/g, " ");
  console.log(
    `[withExpoAudioVoiceProcessing] === PLUGIN START ===\n` +
      `  file=${file}\n` +
      `  size=${content.length} bytes\n` +
      `  head_500=${swiftHead.substring(0, 200)}...\n` +
      `  contains_setAudioModeAsync=${content.includes('AsyncFunction("setAudioModeAsync")')}\n` +
      `  contains_OLD_BLOCK=${content.includes("setCategory(category, mode: .default)")}\n` +
      `  already_has_v56_marker=${content.includes(KODA_PATCH_MARKER)}\n` +
      `  already_has_v63_marker=${content.includes(KODA_ASYNC_FN_MARKER)}`
  );

  const reverted = revertPreviousKodaIosPatch(content);
  if (reverted !== content) {
    fs.writeFileSync(file, reverted, "utf8");
    content = reverted;
  }

  // Injection AsyncFunction v63 (indipendente dalla patch mode v56)
  let v63Injected = false;
  if (!content.includes(KODA_ASYNC_FN_MARKER)) {
    // === v63.3 2026-07-20 FIX ANCHOR ===
    // Anchor precedente `Function("setAudioMode"` NON esiste in expo-audio
    // 1.1.1: la funzione lì si chiama `AsyncFunction("setAudioModeAsync"`.
    // Il plugin quindi loggava "Anchor NOT FOUND" e falliva silenziosamente
    // → sul device `[KODA_AUDIO_MODE] plugin v63 NOT AVAILABLE`.
    //
    // Fix: proviamo una lista di anchor in ordine di preferenza. Il primo
    // che matcha viene usato per l'injection. Aggiungeremo anchor future
    // se la lib rinomina di nuovo.
    const anchorCandidates = [
      'AsyncFunction("setAudioModeAsync")',          // expo-audio 1.1.x (attuale)
      'AsyncFunction("setIsAudioActiveAsync")',      // fallback: subito dopo setAudioModeAsync
      '    Function("setAudioMode"',                 // vecchio (pre-1.1)
    ];
    let idx = -1;
    let matchedAnchor = "";
    for (const cand of anchorCandidates) {
      const i = content.indexOf(cand);
      if (i !== -1) {
        // Rewind fino all'inizio della linea (per allineare l'iniezione a
        // 4 spazi di indent come le sibling AsyncFunction).
        const lineStart = content.lastIndexOf("\n", i) + 1;
        idx = lineStart;
        matchedAnchor = cand;
        break;
      }
    }
    if (idx !== -1) {
      content = content.slice(0, idx) + ASYNC_FN_BLOCK + "\n" + content.slice(idx);
      fs.writeFileSync(file, content, "utf8");
      v63Injected = true;
      console.log(
        "[withExpoAudioVoiceProcessing] ✅ AsyncFunction kodaGetAudioSessionState " +
          "injected (v63.3, anchor='" + matchedAnchor + "')."
      );
    } else {
      // === v63.4 2026-07-20 — LOUD FAIL ===
      // Prima logaggavamo un warn e continuavamo → binario prodotto con
      // plugin v63 non funzionante e utente costretto a scoprirlo runtime.
      // Ora falliamo la build: meglio 0 binari che uno rotto silenzioso.
      throw new Error(
        `[withExpoAudioVoiceProcessing] ❌ FATAL: nessuno degli anchor v63 trovato in ` +
          `AudioModule.swift (${file}). Anchor provati: ` +
          anchorCandidates.map((a) => `"${a}"`).join(", ") +
          `. La versione di expo-audio ha rinominato nuovamente le API → aggiornare ` +
          `anchorCandidates nel plugin prima di rifare la build. ` +
          `File size: ${content.length}b, primi 200 char: ${swiftHead.substring(0, 200)}`
      );
    }
  } else {
    v63Injected = true;
    console.log(
      "[withExpoAudioVoiceProcessing] AsyncFunction v63 already present. Skipping."
    );
  }

  if (content.includes(KODA_PATCH_MARKER)) {
    console.log(
      "[withExpoAudioVoiceProcessing] Patch v56 already applied (marker found). Skipping."
    );
    console.log(
      `[withExpoAudioVoiceProcessing] === PLUGIN DONE === v63=${v63Injected} v56=already_present`
    );
    return;
  }

  if (!content.includes(OLD_BLOCK)) {
    // === v63.4 2026-07-20 — LOUD FAIL ===
    // Il .voiceChat mode è il core della patch. Senza questa, il noise
    // cancellation Apple non è attivo → app inutilizzabile in ambienti
    // rumorosi (auto, treno, bar). Falliamo la build.
    throw new Error(
      `[withExpoAudioVoiceProcessing] ❌ FATAL: OLD_BLOCK non trovato in AudioModule.swift ` +
        `(${file}). La versione di expo-audio ha cambiato la logica setCategory → ` +
        `il .voiceChat patch NON può essere applicato. Aggiornare OLD_BLOCK nel plugin ` +
        `prima di rifare la build. File size: ${content.length}b`
    );
  }

  const patched = content.replace(OLD_BLOCK, NEW_BLOCK);
  fs.writeFileSync(file, patched, "utf8");
  console.log(
    "[withExpoAudioVoiceProcessing] ✅ Voice Processing patch applied to expo-audio AudioModule.swift"
  );
  console.log(
    `[withExpoAudioVoiceProcessing] === PLUGIN DONE === v63=${v63Injected} v56=injected_now`
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
