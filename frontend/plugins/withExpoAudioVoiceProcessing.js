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

const KODA_PATCH_MARKER = "KODA PATCH 2026-07-10 v15 (Voice DSP + 16kHz + PROXIMITY OBSERVER DYNAMIC)";
const KODA_ANDROID_MARKER = "KODA ANDROID PATCH 2026-07-08 v1 (Proximity Sensor auto-routing)";

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
        // === KODA v14 (2026-07-07): Modalità Telefono via Proximity Sensor ===
        // Attiva il monitoring del sensore di prossimità iOS. Con .voiceChat
        // mode + proximity ON, iOS gestisce AUTOMATICAMENTE il routing
        // dell'output:
        //   • Telefono lontano dall'orecchio → LOUDSPEAKER esterno
        //   • Telefono vicino all'orecchio → EARPIECE interno (auricolare)
        // Esattamente come una normale chiamata telefonica. Nessun toggle,
        // nessuna configurazione utente. Se il telefono è connesso a
        // Bluetooth/CarPlay/cuffie, quelle hanno precedenza (non tocchiamo).
        DispatchQueue.main.async {
          UIDevice.current.isProximityMonitoringEnabled = true
        }
        // === KODA v15 (2026-07-10): Observer proximity DINAMICO ===
        // Il flag proximityMonitoringEnabled da solo NON muove l'audio: fa solo
        // dimmerare lo schermo e leggere lo stato. Per ottenere il routing
        // earpiece↔speaker come una vera telefonata serve un observer che al
        // cambio di proximityState chiami overrideOutputAudioPort(.none/.speaker).
        // Guard di idempotenza: nested enum + static var (Swift 5.5+) così
        // ogni chiamata a setCategory non registra observer duplicati.
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
        let extPorts0: Set<AVAudioSession.Port> = [
            .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
            .headphones, .headsetMic,
            .carAudio, .airPlay, .usbAudio,
        ]
        let hasExternal0 = session.currentRoute.outputs.contains { extPorts0.contains($0.portType) }
        if !hasExternal0 {
            do {
                if UIDevice.current.proximityState {
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
        // Proximity sensor ON anche nel ramo con options (usato quando
        // Bluetooth opzioni sono attive).
        DispatchQueue.main.async {
          UIDevice.current.isProximityMonitoringEnabled = true
        }
        // === KODA v15: stesso observer proximity dinamico del ramo principale.
        //   nested enum guard evita registrazioni duplicate anche se
        //   setCategory viene chiamato più volte (ramo options).
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
                do {
                    if UIDevice.current.proximityState {
                        try s.overrideOutputAudioPort(.none)
                    } else {
                        try s.overrideOutputAudioPort(.speaker)
                    }
                } catch { /* silent */ }
            }
        }
        // Routing INIZIALE nel ramo options (BT etc): applica solo se non ci
        // sono device esterni. Se ci sono BT/cuffie, non tocchiamo il routing.
        let extPortsOpt: Set<AVAudioSession.Port> = [
            .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
            .headphones, .headsetMic,
            .carAudio, .airPlay, .usbAudio,
        ]
        let hasExternalOpt = session.currentRoute.outputs.contains { extPortsOpt.contains($0.portType) }
        if !hasExternalOpt {
            do {
                if UIDevice.current.proximityState {
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
  // iOS: patch AudioModule.swift for voiceChat mode + proximity sensor.
  config = withDangerousMod(config, [
    "ios",
    async (config) => {
      patchExpoAudioSwift(config.modRequest.projectRoot);
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
