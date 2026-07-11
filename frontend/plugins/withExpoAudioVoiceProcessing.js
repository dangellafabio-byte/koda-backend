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

const KODA_PATCH_MARKER = "KODA PATCH 2026-07-11 v17 (Voice DSP + 16kHz + PROXIMITY OBSERVER + MANUAL BUTTON)";
const KODA_ANDROID_MARKER = "KODA ANDROID PATCH 2026-07-11 v3 (Proximity Sensor auto-routing + MANUAL BUTTON)";
// Marker specifico per la seconda patch iOS che inietta AsyncFunction("kodaSetAudioOutput")
// dentro il ModuleDefinition di ExpoAudio. Idempotente.
const KODA_V17_ASYNC_MARKER = "KODA_V17_ASYNC_FUNCTION kodaSetAudioOutput";
const KODA_V17_ASYNC_ANDROID_MARKER = "KODA_V17_ANDROID_ASYNC_FUNCTION kodaSetAudioOutput";
// Marker generico usato per riconoscere QUALSIASI vecchia patch KODA (v11, v12,
// v13, v14, v15…) presente nel file cached di node_modules. Serve per il revert
// automatico prima di applicare la versione corrente. NON modificare.
const KODA_GENERIC_IOS_MARKER = "KODA PATCH";
const KODA_GENERIC_ANDROID_MARKER = "KODA ANDROID PATCH";

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
      // motore/vento mantenendo la voce.
      let recordingMode: AVAudioSession.Mode = (category == .playAndRecord) ? .voiceChat : .default
      try session.setCategory(category, mode: recordingMode)
      if category == .playAndRecord {
        // === KODA v14: proximity monitoring on ===
        DispatchQueue.main.async {
          UIDevice.current.isProximityMonitoringEnabled = true
        }
        // === KODA v15 + v17: Observer proximity + MANUAL OVERRIDE ===
        // Il flag proximityMonitoringEnabled da solo NON muove l'audio: serve
        // un observer che al cambio di proximityState chiami
        // overrideOutputAudioPort(.none/.speaker).
        //
        // v17: rispetta anche l'override MANUALE settato dal pulsante UI via
        // AsyncFunction("kodaSetAudioOutput"). Lo storage è UserDefaults key
        // "KodaAudioOverrideMode" con valori "earpiece" | "speaker" | nil.
        // Se manuale attivo → observer NON tocca la route (l'ha già impostata
        // la AsyncFunction). Se manuale nil → observer usa proximity.
        enum KodaProxObserverGuard {
            static var registered = false
        }
        if !KodaProxObserverGuard.registered {
            KodaProxObserverGuard.registered = true
            NotificationCenter.default.addObserver(
                forName: UIDevice.proximityStateDidChangeNotification,
                object: nil,
                queue: .main
            ) { _ in
                let s = AVAudioSession.sharedInstance()
                guard s.category == .playAndRecord else { return }
                let extPorts: Set<AVAudioSession.Port> = [
                    .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
                    .headphones, .headsetMic,
                    .carAudio, .airPlay, .usbAudio,
                ]
                if s.currentRoute.outputs.contains(where: { extPorts.contains($0.portType) }) { return }
                // v17: se c'è override manuale, l'observer NON ricalcola
                if UserDefaults.standard.string(forKey: "KodaAudioOverrideMode") != nil { return }
                do {
                    if UIDevice.current.proximityState {
                        // Vicino all'orecchio → EARPIECE (auricolare interno)
                        try s.overrideOutputAudioPort(.none)
                    } else {
                        // Lontano → LOUDSPEAKER (esterno)
                        try s.overrideOutputAudioPort(.speaker)
                    }
                } catch { /* silent */ }
            }
        }
        // Routing INIZIALE: se il device è già in mano al momento del setCategory,
        // applica subito il routing corretto senza aspettare un cambio di stato.
        // v17: rispetta anche override manuale se già settato dall'UI.
        let extPorts0: Set<AVAudioSession.Port> = [
            .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
            .headphones, .headsetMic,
            .carAudio, .airPlay, .usbAudio,
        ]
        let hasExternal0 = session.currentRoute.outputs.contains { extPorts0.contains($0.portType) }
        if !hasExternal0 {
            do {
                let manualMode0 = UserDefaults.standard.string(forKey: "KodaAudioOverrideMode")
                if manualMode0 == "earpiece" {
                    try session.overrideOutputAudioPort(.none)
                } else if manualMode0 == "speaker" {
                    try session.overrideOutputAudioPort(.speaker)
                } else if UIDevice.current.proximityState {
                    try session.overrideOutputAudioPort(.none)
                } else {
                    try session.overrideOutputAudioPort(.speaker)
                }
            } catch { /* silent */ }
        }
        // === KODA v12: configurazione mic Apple-like (invariata dalla v11) ===
        // 16kHz + Voice data source per beamforming/noise reduction attivi.
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
        DispatchQueue.main.async {
          UIDevice.current.isProximityMonitoringEnabled = true
        }
        enum KodaProxObserverGuardOpt {
            static var registered = false
        }
        if !KodaProxObserverGuardOpt.registered {
            KodaProxObserverGuardOpt.registered = true
            NotificationCenter.default.addObserver(
                forName: UIDevice.proximityStateDidChangeNotification,
                object: nil,
                queue: .main
            ) { _ in
                let s = AVAudioSession.sharedInstance()
                guard s.category == .playAndRecord else { return }
                let extPorts: Set<AVAudioSession.Port> = [
                    .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
                    .headphones, .headsetMic,
                    .carAudio, .airPlay, .usbAudio,
                ]
                if s.currentRoute.outputs.contains(where: { extPorts.contains($0.portType) }) { return }
                if UserDefaults.standard.string(forKey: "KodaAudioOverrideMode") != nil { return }
                do {
                    if UIDevice.current.proximityState {
                        try s.overrideOutputAudioPort(.none)
                    } else {
                        try s.overrideOutputAudioPort(.speaker)
                    }
                } catch { /* silent */ }
            }
        }
        let extPortsOpt: Set<AVAudioSession.Port> = [
            .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
            .headphones, .headsetMic,
            .carAudio, .airPlay, .usbAudio,
        ]
        let hasExternalOpt = session.currentRoute.outputs.contains { extPortsOpt.contains($0.portType) }
        if !hasExternalOpt {
            do {
                let manualModeOpt = UserDefaults.standard.string(forKey: "KodaAudioOverrideMode")
                if manualModeOpt == "earpiece" {
                    try session.overrideOutputAudioPort(.none)
                } else if manualModeOpt == "speaker" {
                    try session.overrideOutputAudioPort(.speaker)
                } else if UIDevice.current.proximityState {
                    try session.overrideOutputAudioPort(.none)
                } else {
                    try session.overrideOutputAudioPort(.speaker)
                }
            } catch { /* silent */ }
        }
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
  // Se la patch corrente (v16) è già applicata, saltiamo.
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
      "[withExpoAudioVoiceProcessing] Revert: anchors (setCategory / activateSession) " +
        "non trovati in AudioModule.swift. Impossibile ripulire la patch precedente. " +
        "La patch nuova potrebbe NON applicarsi. Verifica versione expo-audio."
    );
    return content;
  }
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx); // inizia con "\n  private func activateSession()"
  // OLD_BLOCK termina con "  }" senza newline finale, quindi aggiungo "\n" per
  // ricreare la riga vuota che separa setCategory da activateSession.
  const reverted = before + OLD_BLOCK + "\n" + after;
  console.log(
    "[withExpoAudioVoiceProcessing] ♻️  Patch KODA di versione precedente rilevata in " +
      "AudioModule.swift → ripristino OLD_BLOCK prima di applicare " + KODA_PATCH_MARKER
  );
  return reverted;
}

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

  // Cache-safe: se node_modules su EAS Build contiene già una vecchia patch
  // KODA (v11-v15), ripristiniamo il file originale così la nuova patch può
  // applicarsi. Idempotente: no-op se il file è pulito o già alla versione corrente.
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

// ============================================================================
// KODA v17 iOS PATCH #2: AsyncFunction("kodaSetAudioOutput")
// ============================================================================
// Iniettiamo una nuova AsyncFunction dentro il ModuleDefinition di ExpoAudio,
// che espone a JavaScript la capacità di forzare l'output audio su earpiece o
// speaker (con modalità "auto" che ritorna al proximity observer).
//
// Chiamata da JS: NativeAudioModule.kodaSetAudioOutput("earpiece"|"speaker"|"auto")
//
// Storage: UserDefaults key "KodaAudioOverrideMode" — letto dall'observer v17
// per skippare il routing automatico quando c'è un override manuale attivo.
//
// Rispetta i device esterni (BT/AirPods/CarPlay/cuffie): se ne è collegato
// almeno uno, la funzione ritorna senza fare nulla (l'utente si aspetta che
// il suono resti dove è, cioè sulle cuffie).
// ============================================================================

const SWIFT_ASYNC_FUNCTION_BLOCK = `    // === ${KODA_V17_ASYNC_MARKER} ===
    // AsyncFunction esposta a JS per la Modalità Telefono manuale (pulsante UI).
    // Sostituisce/coesiste con l'observer proximity: se questa funzione viene
    // chiamata con "earpiece"/"speaker", l'observer viene bypassato (via
    // UserDefaults). Chiamata con "auto" rimuove l'override → observer riprende.
    AsyncFunction("kodaSetAudioOutput") { (output: String) -> String in
      #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      let extPorts: Set<AVAudioSession.Port> = [
        .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
        .headphones, .headsetMic,
        .carAudio, .airPlay, .usbAudio,
      ]
      let hasExternal = session.currentRoute.outputs.contains { extPorts.contains($0.portType) }
      if hasExternal {
        // Device esterno collegato: NON tocchiamo il routing. Ritorniamo il
        // nome della prima output port così JS può mostrare l'icona corretta
        // (es. 🎧 AirPods).
        let firstExt = session.currentRoute.outputs.first { extPorts.contains($0.portType) }
        return "external:" + (firstExt?.portName ?? "unknown")
      }
      switch output {
      case "earpiece":
        UserDefaults.standard.set("earpiece", forKey: "KodaAudioOverrideMode")
        do { try session.overrideOutputAudioPort(.none) } catch {}
        return "earpiece"
      case "speaker":
        UserDefaults.standard.set("speaker", forKey: "KodaAudioOverrideMode")
        do { try session.overrideOutputAudioPort(.speaker) } catch {}
        return "speaker"
      default: // "auto" o qualsiasi altro valore → rimuovi override
        UserDefaults.standard.removeObject(forKey: "KodaAudioOverrideMode")
        // Riapplica routing basato su proximity corrente
        do {
          if UIDevice.current.proximityState {
            try session.overrideOutputAudioPort(.none)
            return "auto:earpiece"
          } else {
            try session.overrideOutputAudioPort(.speaker)
            return "auto:speaker"
          }
        } catch { return "auto:error" }
      }
      #else
      return "unsupported"
      #endif
    }

    // Query dello stato corrente (utile per l'UI al mount)
    AsyncFunction("kodaGetAudioOutput") { () -> String in
      #if os(iOS)
      let session = AVAudioSession.sharedInstance()
      let extPorts: Set<AVAudioSession.Port> = [
        .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
        .headphones, .headsetMic,
        .carAudio, .airPlay, .usbAudio,
      ]
      let firstExt = session.currentRoute.outputs.first { extPorts.contains($0.portType) }
      if let ext = firstExt {
        return "external:" + ext.portName
      }
      let manual = UserDefaults.standard.string(forKey: "KodaAudioOverrideMode")
      if let m = manual {
        return m // "earpiece" o "speaker"
      }
      // Nessun override: se proximity attivo → earpiece, altrimenti speaker
      return UIDevice.current.proximityState ? "auto:earpiece" : "auto:speaker"
      #else
      return "unsupported"
      #endif
    }
`;

const SWIFT_ASYNC_ANCHOR = `    AsyncFunction("getRecordingPermissionsAsync") { (promise: Promise) in
      #if os(iOS)
      appContext?.permissions?.getPermissionUsingRequesterClass(
        AudioRecordingRequester.self,
        resolve: promise.resolver,
        reject: promise.legacyRejecter
      )
      #else
      promise.reject(Exception.init(name: "UnsupportedOperation", description: "Audio recording is not supported on this platform."))
      #endif
    }

    OnDestroy {`;

const SWIFT_ASYNC_INJECTED = `    AsyncFunction("getRecordingPermissionsAsync") { (promise: Promise) in
      #if os(iOS)
      appContext?.permissions?.getPermissionUsingRequesterClass(
        AudioRecordingRequester.self,
        resolve: promise.resolver,
        reject: promise.legacyRejecter
      )
      #else
      promise.reject(Exception.init(name: "UnsupportedOperation", description: "Audio recording is not supported on this platform."))
      #endif
    }

${SWIFT_ASYNC_FUNCTION_BLOCK}
    OnDestroy {`;

function patchExpoAudioSwiftAsyncFunction(projectRoot) {
  const file = path.join(
    projectRoot,
    "node_modules",
    "expo-audio",
    "ios",
    "AudioModule.swift"
  );
  if (!fs.existsSync(file)) return;
  let content = fs.readFileSync(file, "utf8");
  // Cache-safe: se esiste già una vecchia iniezione KODA_V17_ASYNC_FUNCTION con
  // versione diversa da quella corrente, la rimuoviamo prima di iniettare la
  // nuova. Serve a bypassare la cache node_modules su EAS Build.
  const GENERIC_START_MARKER = "// === KODA_V17_ASYNC_FUNCTION";
  if (
    content.includes(GENERIC_START_MARKER) &&
    !content.includes(KODA_V17_ASYNC_MARKER)
  ) {
    // Trova il blocco: da "    // === KODA_V17_ASYNC_FUNCTION" fino a "    OnDestroy {"
    const startAnchor = "    // === KODA_V17_ASYNC_FUNCTION";
    const endAnchor = "    OnDestroy {";
    const s = content.indexOf(startAnchor);
    const e = content.indexOf(endAnchor, s);
    if (s !== -1 && e !== -1) {
      // Rimuovi da s fino a e (esclusivo) — lascia solo endAnchor
      const before = content.slice(0, s);
      const after = content.slice(e);
      content = before + after;
      fs.writeFileSync(file, content, "utf8");
      console.log(
        "[withExpoAudioVoiceProcessing][iOS AsyncFunc] ♻️  Old KODA AsyncFunction " +
          "detected (different version). Removed before re-injecting current version."
      );
    }
  }
  // Idempotente: se il marker corrente è presente skip.
  if (content.includes(KODA_V17_ASYNC_MARKER)) {
    console.log(
      "[withExpoAudioVoiceProcessing][iOS AsyncFunc] Already injected, skipping."
    );
    return;
  }
  if (!content.includes(SWIFT_ASYNC_ANCHOR)) {
    console.warn(
      "[withExpoAudioVoiceProcessing][iOS AsyncFunc] Anchor block " +
        "(getRecordingPermissionsAsync + OnDestroy) NOT found. Manual button " +
        "AsyncFunction NOT injected. expo-audio may have changed."
    );
    return;
  }
  const patched = content.replace(SWIFT_ASYNC_ANCHOR, SWIFT_ASYNC_INJECTED);
  fs.writeFileSync(file, patched, "utf8");
  console.log(
    "[withExpoAudioVoiceProcessing][iOS AsyncFunc] ✅ kodaSetAudioOutput + " +
      "kodaGetAudioOutput injected into ExpoAudio ModuleDefinition."
  );
}

// ============================================================================
// ANDROID: Proximity Sensor Auto-Routing
// ============================================================================
// PROBLEMA: su Android, `expo-audio` gestisce `shouldRouteThroughEarpiece` come
// flag statico. Non c'è routing automatico basato sul sensore di prossimità.
// Quando l'utente porta il telefono all'orecchio, l'audio continua a uscire
// dall'altoparlante esterno — comportamento imbarazzante in pubblico.
//
// SOLUZIONE: patcha `AudioModule.kt` per registrare un `SensorEventListener`
// sul sensore TYPE_PROXIMITY. Durante il playback di un `AudioPlayer` attivo:
//   • distanza < 5cm → MODE_IN_COMMUNICATION + speakerphoneOn(false) → earpiece
//   • distanza >= 5cm → speakerphoneOn(true) + MODE_NORMAL → altoparlante
// Il listener è passivo: agisce SOLO se players.isPlaying == true.
// Nessuna interazione richiesta dal codice JS; il comportamento è nativo.
//
// Idempotente: skip se marker già presente.
// ============================================================================

const ANDROID_OLD_IMPORTS = `import android.Manifest
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager`;

const ANDROID_NEW_IMPORTS = `import android.Manifest
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager`;

const ANDROID_OLD_FIELDS = `  private var shouldRouteThroughEarpiece = false
  private var focusAcquired = false`;

const ANDROID_NEW_FIELDS = `  private var shouldRouteThroughEarpiece = false
  private var focusAcquired = false
  // === ${KODA_ANDROID_MARKER} ===
  private var kodaProximitySensorManager: SensorManager? = null
  private var kodaProximitySensor: Sensor? = null
  private var kodaProximityListener: SensorEventListener? = null
  private var kodaProximityForcedEarpiece = false`;

const ANDROID_OLD_ONCREATE = `    OnCreate {
      audioManager = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }`;

const ANDROID_NEW_ONCREATE = `    OnCreate {
      audioManager = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      // === ${KODA_ANDROID_MARKER} ===
      // Registra listener sul sensore di prossimità. Il listener toggla
      // automaticamente il routing (earpiece vs speaker) durante il playback
      // di TTS. Se il device non ha proximity sensor (rari tablet), skip.
      try {
        val sm = appContext.reactContext?.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val ps = sm?.getDefaultSensor(Sensor.TYPE_PROXIMITY)
        if (sm != null && ps != null) {
          kodaProximitySensorManager = sm
          kodaProximitySensor = ps
          val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
              try {
                val distance = event.values.getOrNull(0) ?: return
                // "Near" = distance < 5cm AND distance < maxRange.
                // Threshold 5cm evita falsi positivi in tasca (>= maxRange).
                val isNear = distance < 5f && distance < ps.maximumRange
                // Auto-toggle SOLO se un player sta suonando (TTS attivo).
                val hasPlaying = players.values.any { it.ref.isPlaying }
                if (hasPlaying && isNear && !kodaProximityForcedEarpiece) {
                  // Telefono all'orecchio → route to earpiece
                  audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                  @Suppress("DEPRECATION")
                  audioManager.setSpeakerphoneOn(false)
                  kodaProximityForcedEarpiece = true
                } else if (kodaProximityForcedEarpiece && (!hasPlaying || !isNear)) {
                  // Telefono lontano dall'orecchio o TTS finito → altoparlante
                  @Suppress("DEPRECATION")
                  audioManager.setSpeakerphoneOn(true)
                  // Ripristina MODE_NORMAL solo se non stiamo in earpiece manuale
                  if (!shouldRouteThroughEarpiece) {
                    audioManager.mode = AudioManager.MODE_NORMAL
                  }
                  kodaProximityForcedEarpiece = false
                }
              } catch (_: Exception) {}
            }
            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
          }
          kodaProximityListener = listener
          sm.registerListener(listener, ps, SensorManager.SENSOR_DELAY_NORMAL)
        }
      } catch (_: Exception) {}
    }`;

const ANDROID_OLD_ONDESTROY = `    OnDestroy {
      appContext.mainQueue.launch {
        releaseAudioFocus()`;

const ANDROID_NEW_ONDESTROY = `    OnDestroy {
      // === ${KODA_ANDROID_MARKER} ===
      // Cleanup listener del sensore di prossimità.
      try {
        kodaProximityListener?.let { l ->
          kodaProximitySensorManager?.unregisterListener(l)
        }
        kodaProximityListener = null
        kodaProximitySensorManager = null
        kodaProximitySensor = null
      } catch (_: Exception) {}
      appContext.mainQueue.launch {
        releaseAudioFocus()`;

function patchExpoAudioKotlin(projectRoot) {
  const file = path.join(
    projectRoot,
    "node_modules",
    "expo-audio",
    "android",
    "src",
    "main",
    "java",
    "expo",
    "modules",
    "audio",
    "AudioModule.kt"
  );

  if (!fs.existsSync(file)) {
    console.warn(
      `[withExpoAudioVoiceProcessing][Android] AudioModule.kt NOT FOUND at ${file}. Skipping.`
    );
    return;
  }

  let content = fs.readFileSync(file, "utf8");

  if (content.includes(KODA_ANDROID_MARKER)) {
    console.log(
      "[withExpoAudioVoiceProcessing][Android] Patch already applied (marker found). Skipping."
    );
    return;
  }

  if (
    content.includes(KODA_GENERIC_ANDROID_MARKER) &&
    !content.includes(KODA_ANDROID_MARKER)
  ) {
    // Vecchia patch KODA Android rilevata (v1 o precedente): i blocchi OLD non
    // matchano più → la nuova patch non si applicherebbe. Segnaliamo all'utente
    // che deve pulire node_modules su EAS. Su build iOS questo non tocca nulla.
    console.warn(
      "[withExpoAudioVoiceProcessing][Android] ⚠️  Patch KODA precedente rilevata in " +
        "AudioModule.kt. Per applicare " + KODA_ANDROID_MARKER + " esegui su EAS " +
        "un build con 'clean cache' oppure elimina node_modules/expo-audio e reinstalla. " +
        "Skip patch Android (routing proximity Android NON attivo su questa build)."
    );
    return;
  }

  let ok = true;

  if (content.includes(ANDROID_OLD_IMPORTS)) {
    content = content.replace(ANDROID_OLD_IMPORTS, ANDROID_NEW_IMPORTS);
  } else {
    console.warn("[withExpoAudioVoiceProcessing][Android] IMPORTS block not found.");
    ok = false;
  }

  if (content.includes(ANDROID_OLD_FIELDS)) {
    content = content.replace(ANDROID_OLD_FIELDS, ANDROID_NEW_FIELDS);
  } else {
    console.warn("[withExpoAudioVoiceProcessing][Android] FIELDS block not found.");
    ok = false;
  }

  if (content.includes(ANDROID_OLD_ONCREATE)) {
    content = content.replace(ANDROID_OLD_ONCREATE, ANDROID_NEW_ONCREATE);
  } else {
    console.warn("[withExpoAudioVoiceProcessing][Android] ONCREATE block not found.");
    ok = false;
  }

  if (content.includes(ANDROID_OLD_ONDESTROY)) {
    content = content.replace(ANDROID_OLD_ONDESTROY, ANDROID_NEW_ONDESTROY);
  } else {
    console.warn("[withExpoAudioVoiceProcessing][Android] ONDESTROY block not found.");
    ok = false;
  }

  if (!ok) {
    console.warn(
      "[withExpoAudioVoiceProcessing][Android] One or more patch blocks not found. " +
        "expo-audio version may have changed. Proximity auto-routing NOT activated."
    );
    return;
  }

  fs.writeFileSync(file, content, "utf8");
  console.log(
    "[withExpoAudioVoiceProcessing][Android] ✅ Proximity Sensor auto-routing patch applied to AudioModule.kt"
  );
}

module.exports = function withExpoAudioVoiceProcessing(config) {
  // iOS: patch AudioModule.swift for voiceChat mode + proximity sensor + manual button.
  config = withDangerousMod(config, [
    "ios",
    async (config) => {
      patchExpoAudioSwift(config.modRequest.projectRoot);
      patchExpoAudioSwiftAsyncFunction(config.modRequest.projectRoot);
      return config;
    },
  ]);
  // Android: patch AudioModule.kt for proximity sensor auto-routing.
  config = withDangerousMod(config, [
    "android",
    async (config) => {
      patchExpoAudioKotlin(config.modRequest.projectRoot);
      return config;
    },
  ]);
  return config;
};
