/**
 * LASCIA ANDARE — "Un posto dove nessuno risponde."
 *
 * Concept (Fabio, 2026-07-16):
 *   L'utente entra, lo schermo diventa nero, solo l'orb è visibile.
 *   L'utente parla liberamente. L'orb pulsa mentre sente la voce
 *   (feedback visivo di ascolto). Koda NON risponde — né voce né testo.
 *   Zero trascrizione, zero Claude, zero ElevenLabs, zero rete.
 *   Solo il VAD locale sul dispositivo rileva quando l'utente parla.
 *   Quando l'utente esce, zero traccia rimane né sul server né sul telefono.
 *
 * Implementazione:
 *   • expo-audio recorder in modalità metering-only (16 kHz, m4a in tmp)
 *   • Poll metering ogni 100 ms → dB in ingresso
 *   • Semplice VAD con isteresi: > SPEECH_DB → orb "recording", < SILENCE_DB
 *     per >= SILENCE_MS → orb torna a "idle"
 *   • Nessuna chiamata fetch/WebSocket in tutto il file
 *   • All'uscita: recorder.stop(), release, e cancellazione FISICA del
 *     file temporaneo su disco (expo-file-system)
 *   • Nessuna scrittura su AsyncStorage / MongoDB / timeline
 *
 * Garanzia: cerca in questo file "fetch(", "WebSocket(", "api." — non
 * esistono. L'audio non lascia il dispositivo e non viene persistito.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  BackHandler,
  Animated,
  Easing,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import EclipseOrb, { OrbStatus } from "../components/EclipseOrb";
import {
  playOpenPhrase,
  playClosePhrase,
  stopAll as stopVoicePhrase,
} from "../lib/lasciaAndareVoice";
// NB: rimosso `import { api } from "../lib/api"` — non più necessario dopo la
// rimozione del guard `authorizeLasciaAndare` (Punto 3, Fabio 2026-08-17).

// ==== VAD tuning (calibrato sulla stessa scala di lib/voice.ts) ====
const SPEECH_DB = -35; // sopra questa soglia → voce presente
const SILENCE_DB = -45; // sotto questa soglia → silenzio (isteresi)
const SILENCE_HOLD_MS = 700; // millisecondi di silenzio per tornare a idle
const METER_POLL_MS = 100;

// ==== Animation tuning (Fabio 2026-07-17 rev2) ====
// Ingresso: emergere lento dall'oscurità (2.5s)
const ENTRY_DURATION_MS = 2500;
const ENTRY_HINT_DELAY_MS = 1800; // Il testo appare dopo l'orb
// Uscita: sparire nel nero (1.2s)
const EXIT_DURATION_MS = 1200;
// Respiro base: seno lento continuo (~5.2s cycle)
const BREATH_HALF_CYCLE_MS = 2600;
const BREATH_SCALE_PEAK = 1.05;
// Pulsazione voce: quando il VAD dice "speaking:true" l'orb entra in un
// loop di pulsazione ampio e visibile ("respira insieme a chi parla").
// Quando "speaking:false" torna dolcemente a 1.0 (solo il respiro base
// del breathScale continua).
const VOICE_PULSE_PEAK = 1.22; // Espansione ~22% quando l'utente parla
const VOICE_PULSE_HALF_CYCLE_MS = 650; // 1.3s per un ciclo completo (in/out)
const VOICE_RELEASE_MS = 500; // Ritorno dolce a 1.0 quando la voce cessa

export default function LasciaAndareScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // === VOICE PARAM (2026-07-27) — presenza vocale in apertura/chiusura ===
  //
  // La schermata riceve la voce Koda scelta dall'utente come route param
  // (es. router.push("/lascia-andare?voice=aria")). Serve per riprodurre
  // due brevi frasi pre-registrate:
  //   - Apertura: "Prenditi il tuo tempo."
  //   - Chiusura: "Grazie per averlo lasciato andare."
  //
  // I file audio sono BUNDLED con l'app (assets/sounds/lascia-andare/*.mp3)
  // — nessuna chiamata di rete a runtime, coerentemente col vincolo di
  // privacy della Stanza dello Sfogo.
  //
  // Chiavi accettate: "aria"|"cielo" (femminile) | "echo"|"vento" (maschile).
  // Fallback Cielo se assente o non riconosciuta.
  const params = useLocalSearchParams<{ voice?: string }>();
  const voiceKey = (params?.voice as string) || "aria";
  // === FIX 2026-07-26 v64.1 — Orb sempre in "recording" nella stanza sfogo ===
  //
  // PROBLEMA (Fabio 26/07):
  //   Nella stanza "Lascia Andare" (sfogo), l'orb appariva statico e
  //   color sabbia (stato "idle") su tutti i device (Huawei, Xiaomi,
  //   iPhone). Doveva invece pulsare visibilmente per comunicare
  //   "Koda ti sta ascoltando incondizionatamente".
  //
  // ROOT CAUSE:
  //   Il VAD partiva da "idle" e passava a "recording" solo se il dB
  //   grezzo superava SPEECH_DB. Su alcuni device il metering è
  //   sottostimato (mic sensitivity bassa) o l'utente non parlava
  //   subito → orb restava sabbia inutilmente.
  //
  // FIX (richiesta esplicita utente):
  //   Nella stanza sfogo l'orb DEVE sempre apparire "in ascolto"
  //   dal momento dell'ingresso. Partiamo direttamente da "recording"
  //   invece che "idle". La logica VAD sotto è disattivata per il
  //   visual state (ora è sempre "recording"); il metering continua
  //   ad essere letto per altri usi (silence detection UI, ecc.)
  //   ma non tocca più `status`.
  const [status, setStatus] = useState<OrbStatus>("recording");
  const [meterDb, setMeterDb] = useState<number>(-100);
  const [ready, setReady] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);

  // === LIVELLO 2+3 GUARD → RIMOSSO (Punto 3, Fabio 2026-08-17) ============
  // Ex "checking → allowed/denied" con network fetch al mount. Ora Lascia
  // Andare è free per sempre → `authorized` parte direttamente a "allowed".
  // Il tipo/stato è mantenuto per compat con gli useEffect a valle che
  // filtrano su `authorized !== "allowed"` (safety net inerte).
  const [authorized, setAuthorized] = useState<"checking" | "allowed" | "denied">("allowed");

  // === PUNTO 7 — CLEANUP PREEMPTIVO ORFANI AUDIO (Fabio 2026-08-17) ========
  // Vincolo di Fabio: "niente audio deve restare sul telefono dopo che
  // l'utente esce da Lascia Andare". Il cleanup runtime (`stopAndCleanup`)
  // cancella il file dell'ultima sessione, MA non copre due edge case:
  //   1. Crash / kill-task-manager durante una sessione attiva → il
  //      file `.m4a` resta orfano in cacheDirectory.
  //   2. Multiple sessioni non chiuse cleanly nel passato.
  //
  // Al mount della schermata Lascia Andare (che è idempotente su una
  // sessione già in corso) facciamo un cleanup best-effort dei file `.m4a`
  // orfani nella cacheDirectory più vecchi di 5 minuti.
  //
  // Vincoli difensivi:
  //   - Solo `.m4a` (i `.mp3` in cache sono TTS di Koda conv, non nostri —
  //     vedi lib/speech.ts:1465 `koda_ws_{ts}_{idx}.mp3` — NON toccarli)
  //   - Solo file con mtime > 5 minuti fa (se qualcuno è ancora attivo
  //     lasciamo stare, il cleanup runtime lo prenderà a session end)
  //   - Silenzioso: nessun blocco UI, nessun error propagato all'utente
  //   - Fire-and-forget: non aspettiamo l'esito per renderizzare la schermata
  //
  // Costo runtime: ~10-50ms (una readDirectoryAsync + N getInfoAsync su
  // pochi file). Non blocca il critical path del boot.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dir = (FileSystem as any).cacheDirectory as string | null;
        if (!dir) {
          console.log("[LasciaAndare/cleanup] cacheDirectory unavailable — skip");
          return;
        }
        const entries = await FileSystem.readDirectoryAsync(dir);
        if (cancelled) return;
        const now = Date.now();
        const AGE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minuti
        let deleted = 0;
        let skipped = 0;
        for (const name of entries) {
          if (cancelled) return;
          // Whitelist estensione: solo .m4a (audio recorder Lascia Andare).
          // Escludiamo esplicitamente qualsiasi `koda_ws_*.mp3` (TTS Koda conv)
          // e `koda_offline_*.mp3` (clip offline preload).
          if (!name.toLowerCase().endsWith(".m4a")) {
            skipped++;
            continue;
          }
          const path = `${dir}${name}`;
          try {
            const info: any = await FileSystem.getInfoAsync(path);
            if (!info?.exists) continue;
            // modificationTime è in SECONDI (unix), non ms.
            const mtimeMs = typeof info.modificationTime === "number"
              ? info.modificationTime * 1000
              : 0;
            const ageMs = now - mtimeMs;
            if (ageMs < AGE_THRESHOLD_MS) {
              skipped++;
              continue; // troppo recente → potrebbe essere in uso
            }
            await FileSystem.deleteAsync(path, { idempotent: true });
            deleted++;
          } catch (e) {
            // Silenzioso: se un singolo file fallisce, andiamo avanti
            console.log(`[LasciaAndare/cleanup] skip ${name}: ${e}`);
          }
        }
        console.log(
          `[LasciaAndare/cleanup] preemptive m4a orphans: deleted=${deleted} skipped=${skipped}`
        );
      } catch (e) {
        // readDirectoryAsync può fallire su alcuni device — non blocchiamo
        console.log(`[LasciaAndare/cleanup] scan failed (non-fatal): ${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ref al recorder nativo (istanza AudioRecorder di expo-audio)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recorderRef = useRef<any>(null);
  // Path del file temporaneo che il recorder crea. Lo cancelliamo all'uscita.
  const tempUriRef = useRef<string | null>(null);
  // Timestamp ultima voce rilevata (per silence-hold)
  const lastVoiceAtRef = useRef<number>(0);
  // Interval di polling metering
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guard per evitare doppia teardown
  const teardownStartedRef = useRef(false);

  // === ANIMATED VALUES (Fabio 2026-07-17 rev3) =========================
  // Combinati via Animated.multiply nel transform: entry × breath × voice
  // - orbEntryScale: 0.3 → 1.0 all'ingresso, 1.0 → 0 all'uscita
  // - orbOpacity:    0   → 1   all'ingresso, 1   → 0 all'uscita
  // - breathScale:   loop 1.0 ↔ 1.05 in seno lento (respiro di base)
  // - voiceScale:    LOOP 1.0 ↔ 1.22 quando speaking=true (pulsazione
  //                  visibile), ritorno a 1.0 quando speaking=false.
  //                  Rev3: sganciato dal dB grezzo — ora è pilotato dal
  //                  flag di stato `status` che riflette il VAD.
  // - hintOpacity:   fade-in ritardato del testo in basso
  const orbEntryScale = useRef(new Animated.Value(0.3)).current;
  const orbOpacity = useRef(new Animated.Value(0)).current;
  const breathScale = useRef(new Animated.Value(1)).current;
  const voiceScale = useRef(new Animated.Value(1)).current;
  const hintOpacity = useRef(new Animated.Value(0)).current;
  // Guard uscita: se l'uscita è già iniziata NON riavviamo animazioni
  const exitingRef = useRef(false);

  // === TEARDOWN — chiamato all'uscita ================================
  // 1) ferma il polling
  // 2) stop del recorder + release
  // 3) elimina FISICAMENTE il file temporaneo su disco
  // 4) disattiva la sessione audio (libera microfono)
  const teardown = useCallback(async () => {
    if (teardownStartedRef.current) return;
    teardownStartedRef.current = true;

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    const rec = recorderRef.current;
    recorderRef.current = null;

    if (rec) {
      try {
        await rec.stop();
      } catch {}
      try {
        // Cattura l'URI PRIMA di release (dopo release non è leggibile)
        const statusUrl = rec.getStatus?.()?.url || null;
        const directUri = rec.uri || null;
        tempUriRef.current = statusUrl || directUri || tempUriRef.current;
      } catch {}
      try {
        rec.release?.();
      } catch {}
    }

    // Cancellazione FISICA del file temporaneo. È fondamentale:
    // niente audio deve restare sul telefono dopo che l'utente esce.
    const uri = tempUriRef.current;
    if (uri) {
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
      } catch {}
    }
    tempUriRef.current = null;

    // Libera la sessione audio (Bluetooth/altoparlante, ecc.)
    try {
      await setIsAudioActiveAsync(false);
    } catch {}
  }, []);

  // === ANIMAZIONE DI INGRESSO (2.5s) ===================================
  // L'orb non appare di botto: emerge lentamente dall'oscurità.
  // - opacity 0 → 1 in 2.2s (fade morbido)
  // - scale 0.3 → 1.0 in 2.5s con easing cubic (crescita naturale)
  // - hint text fade-in ritardato di 1.8s (l'orb arriva prima, il testo poi)
  // Le animazioni di respiro/voce partono comunque in parallelo — la
  // loro moltiplicazione con orbEntryScale=0.3 le rende inizialmente
  // trascurabili, poi si integrano gradualmente man mano che entryScale
  // sale verso 1.0.
  // === LIVELLO 2+3 AUTHORIZATION GATE — RIMOSSO (Punto 3, Fabio 2026-08-17) ==
  // Contesto: prima qui c'era un guard che chiamava /api/lascia-andare/authorize
  // al mount e faceva default-deny in caso di errore/rete assente. Con il
  // Punto 1 del piano Free/Premium, l'endpoint ritorna SEMPRE
  // `allowed=true, reason="free_forever"` — quindi il guard era diventato un
  // no-op che aggiungeva latenza al mount e una chiamata di rete inutile
  // durante Lascia Andare (vincolo Q7 del piano: "zero endpoint chiamati
  // durante Lascia Andare"). Rimosso il guard, `authorized` parte già a
  // "allowed" (vedi useState sopra) → schermata renderizza immediatamente.
  // Il tipo `"checking" | "allowed" | "denied"` è mantenuto per non toccare
  // gli useEffect a valle che filtrano su `authorized !== "allowed"` — quei
  // guard restano come safety net ma non scatteranno mai in condizioni normali.
  useEffect(() => {
    // Guard: non avviare animazioni finché non autorizzato
    if (authorized !== "allowed") return;
    const entry = Animated.parallel([
      Animated.timing(orbOpacity, {
        toValue: 1,
        duration: ENTRY_DURATION_MS - 300,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(orbEntryScale, {
        toValue: 1,
        duration: ENTRY_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.delay(ENTRY_HINT_DELAY_MS),
        Animated.timing(hintOpacity, {
          toValue: 1,
          duration: 800,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    ]);
    entry.start();

    // Nota (2026-07-27 v2): la riproduzione della frase di apertura
    // NON avviene più qui. È stata spostata dentro il setup useEffect,
    // PRIMA di attivare il microfono, per garantire che l'audio esca
    // dallo speaker principale (non dall'earpiece iOS) e che parta
    // correttamente su Android (dove il recorder rubava il focus audio).
    // Vedi commento "PRESENZA VOCALE — Apertura" nel setup useEffect.

    return () => {
      // Se il componente viene smontato durante l'entrata, ferma tutto
      entry.stop();
      // Ferma anche eventuale playback in corso (safety net)
      stopVoicePhrase();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  // === RESPIRO CONTINUO (loop) =========================================
  // Onda sinusoidale lenta: l'orb "respira" anche in silenzio (~5.2s).
  // Multiplicative rispetto a orbEntryScale e voiceScale.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathScale, {
          toValue: BREATH_SCALE_PEAK,
          duration: BREATH_HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breathScale, {
          toValue: 1.0,
          duration: BREATH_HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === PULSAZIONE VOCE — pilotata dal flag VAD (rev3, 2026-07-17) =====
  // Quando il VAD passa a status="recording" (== speaking:true), l'orb
  // entra in un loop di pulsazione ampio e visibile:
  //   1.0 → 1.22 → 1.0 in 1.3s (mezzo ciclo ~650ms, seno).
  // Quando status torna a "idle" (== speaking:false), fermiamo il loop
  // e riportiamo dolcemente voiceScale a 1.0 in 500ms — l'orb torna così
  // al solo respiro base (breathScale continua indipendentemente).
  //
  // Perché così e non più il dB continuo:
  //   Prima mappavamo dB → voiceScale in modo continuo con soglia anti-
  //   jitter (delta 0.015). Nel bundle finale la variazione risultava
  //   troppo timida per essere visibile sopra il breathScale (5%).
  //   Ora usiamo direttamente il flag boolean che il VAD già emette →
  //   pulsazione pronunciata e leggibile a colpo d'occhio.
  useEffect(() => {
    if (exitingRef.current) return; // durante l'uscita non tocchiamo la voce

    if (status === "recording") {
      // Parte dal valore corrente (che dovrebbe essere ~1.0) e loopa
      const pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(voiceScale, {
            toValue: VOICE_PULSE_PEAK,
            duration: VOICE_PULSE_HALF_CYCLE_MS,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(voiceScale, {
            toValue: 1.0,
            duration: VOICE_PULSE_HALF_CYCLE_MS,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ])
      );
      pulseLoop.start();
      return () => pulseLoop.stop();
    } else {
      // Silenzio: ritorno morbido a 1.0. Il breathScale continua da solo.
      Animated.timing(voiceScale, {
        toValue: 1.0,
        duration: VOICE_RELEASE_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // === SETUP — chiamato al mount ======================================
  useEffect(() => {
    // === LIVELLO 2+3 GUARD ==============================================
    // Non chiediamo permessi microfono né inizializziamo il recorder
    // finché authorize non ha confermato l'accesso. Se denied, il
    // guard useEffect sopra ha già triggerato router.replace.
    if (authorized !== "allowed") return;

    let cancelled = false;

    const setup = async () => {
      try {
        // Permesso microfono (chiede solo se necessario)
        const p = await requestRecordingPermissionsAsync();
        if (!p?.granted) {
          setPermError(
            p?.canAskAgain === false
              ? "Serve il permesso microfono. Apri Impostazioni per abilitarlo."
              : "Serve il permesso microfono per proseguire."
          );
          return;
        }

        // === FIX 2026-07-27 v2 — Audio session in DUE FASI ===============
        //
        // BUG risolto (segnalato dall'utente dopo la prima versione):
        //   - iPhone: la frase di apertura si sentiva dall'EARPIECE (auricolare
        //     in alto) invece che dal vivavoce. Causa: se `allowsRecording: true`
        //     è già attivo quando parte il playback, iOS mette la audio session
        //     in categoria "PlayAndRecord" che routa di default all'earpiece.
        //   - Android (Huawei, Honor): la frase di apertura non si sentiva
        //     proprio. Causa: il recorder attivato prima del player prendeva
        //     l'audio focus, il player non riusciva a partire.
        //
        // FIX: separiamo in due fasi la audio session
        //   FASE 1 — PLAYBACK ONLY (allowsRecording: false)
        //     → categoria Playback su iOS, route allo SPEAKER
        //     → nessun mic attivo, il player ha via libera anche su Android
        //     → riproduciamo "Prenditi il tuo tempo." e ATTENDIAMO che finisca
        //   FASE 2 — RECORDING (allowsRecording: true)
        //     → categoria PlayAndRecord su iOS (il mic è ora attivo per il VAD)
        //     → prepareToRecordAsync + record() + polling metering
        //
        // La stessa strategia viene usata in reverse in handleExit per la
        // frase di chiusura.

        // FASE 1: Audio mode = PLAYBACK only (speaker routing)
        try {
          await setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          });
          await setIsAudioActiveAsync(true);
        } catch {}

        if (cancelled) return;

        // === PRESENZA VOCALE — Apertura (v2, 2026-07-27) ================
        // Riproduzione BLOCCANTE della frase di apertura mentre l'audio
        // session è ancora in modalità playback → speaker principale.
        // Fire-and-forget su errore (non vogliamo bloccare l'utente se
        // il file audio non parte per qualche motivo).
        try {
          await playOpenPhrase(voiceKey);
        } catch (e) {
          console.warn("[LasciaAndare] open phrase failed:", e);
        }

        if (cancelled) return;

        // FASE 2: Audio mode = RECORDING (mic attivo per il VAD)
        try {
          await setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
            shouldPlayInBackground: false,
            shouldRouteThroughEarpiece: false,
          });
          await setIsAudioActiveAsync(true);
        } catch {}

        if (cancelled) return;

        // Costruisci un preset light: metering ON, bitrate basso.
        // Il file scritto su disco è irrilevante per noi — lo cancelleremo
        // all'uscita — quindi teniamo qualsiasi impostazione compatibile.
        const base = (RecordingPresets as any).HIGH_QUALITY || {};
        const preset = {
          ...base,
          extension: ".m4a",
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 24000,
          isMeteringEnabled: true,
          android: {
            ...(base.android || {}),
            extension: ".m4a",
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 24000,
            outputFormat: "mpeg4",
            audioEncoder: "aac",
            isMeteringEnabled: true,
            audioSource: "voice_communication",
          },
          ios: {
            ...(base.ios || {}),
            extension: ".m4a",
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 24000,
          },
          web: {
            ...(base.web || {}),
            mimeType: "audio/webm",
            bitsPerSecond: 24000,
          },
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rec: any = new (AudioModule as any).AudioRecorder({});
        try {
          await rec.prepareToRecordAsync(preset);
        } catch {
          // Fallback: preset default con metering
          await rec.prepareToRecordAsync({
            ...(RecordingPresets as any).HIGH_QUALITY,
            isMeteringEnabled: true,
          });
        }
        if (cancelled) {
          try {
            await rec.stop();
          } catch {}
          try {
            rec.release?.();
          } catch {}
          return;
        }

        rec.record();
        recorderRef.current = rec;
        // Cattura URI subito (per cancellazione a fine sessione)
        try {
          tempUriRef.current = rec.getStatus?.()?.url || rec.uri || null;
        } catch {}

        setReady(true);

        // === Polling metering (VAD locale) ===============================
        // Nessun invio di rete: leggiamo solo il livello del microfono in dB
        // e aggiorniamo lo stato dell'orb. L'audio scritto nel .m4a non
        // viene MAI letto né trasmesso — verrà cancellato all'uscita.
        lastVoiceAtRef.current = 0;
        pollRef.current = setInterval(() => {
          if (exitingRef.current) return; // durante l'uscita non aggiorniamo
          try {
            const st = recorderRef.current?.getStatus?.();
            if (!st || !st.isRecording) return;
            const db: number =
              typeof st.metering === "number" ? st.metering : -100;
            setMeterDb(db);
            const now = Date.now();
            if (db > SPEECH_DB) {
              lastVoiceAtRef.current = now;
              // v64.1: già "recording" di default, no-op se non cambia
              setStatus((prev) => (prev === "recording" ? prev : "recording"));
            } else if (db < SILENCE_DB) {
              // === FIX 2026-07-26 v64.1 — NON tornare mai a "idle" ===
              // Nella stanza sfogo l'orb deve sempre pulsare come se
              // stesse ascoltando. Ignoriamo la transizione idle del
              // vecchio VAD. Il metering continua a girare per altri
              // eventuali usi ma non cambia più `status`.
              // (Vecchio codice: setStatus("idle") dopo SILENCE_HOLD_MS)
              const since = lastVoiceAtRef.current
                ? now - lastVoiceAtRef.current
                : Infinity;
              // silence holds tracked ma non trigger visivo — vedi commento sopra
              void since;
            }
            // Zona morta tra SILENCE_DB e SPEECH_DB → mantieni stato corrente
            // NOTA rev3 (2026-07-17): la pulsazione dell'orb NON è più
            // pilotata da questo dB grezzo — è invece un loop guidato
            // dal flag `status` (vedi useEffect sotto). Questo perché il
            // dB continuo con anti-jitter risultava troppo timido per
            // essere visibile sopra il respiro di base.
          } catch {
            // metering può fallire brevemente tra state transitions
          }
        }, METER_POLL_MS);
      } catch (e) {
        console.warn("[LasciaAndare] setup error:", e);
        setPermError("Non è stato possibile aprire il microfono. Riprova.");
      }
    };

    setup();

    return () => {
      cancelled = true;
      // Cleanup su unmount (safety net)
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === Hardware back (Android) → uscita pulita ==========================
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleExit();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleExit = useCallback(async () => {
    // Idempotent: se l'uscita è già in corso, non ripetiamo
    if (exitingRef.current) return;
    exitingRef.current = true;

    // Ferma il polling metering subito così la pulsazione voce
    // non prova a contrastare l'animazione di scomparsa
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    // Rilassa il voiceScale a 1.0 così l'orb non "salta" durante l'exit
    voiceScale.stopAnimation();
    voiceScale.setValue(1.0);

    // === FIX 2026-07-27 v2 — Rilascio mic PRIMA della frase di chiusura ==
    // Stessa strategia in reverse rispetto al setup:
    //   1) Fermiamo e rilasciamo il recorder (libera il mic)
    //   2) Passiamo la audio session a PLAYBACK-ONLY (speaker su iOS)
    //   3) Riproduciamo la frase di chiusura
    //   4) Animazione di uscita + teardown finale
    //
    // Perché così: se restassimo in modalità "PlayAndRecord" mentre suoniamo
    // la chiusura, iPhone routerebbe il suono all'earpiece (auricolare)
    // e Android potrebbe non riprodurlo del tutto.
    const rec = recorderRef.current;
    if (rec) {
      try {
        await rec.stop();
      } catch {}
      try {
        // Cattura l'URI PRIMA di release per la cancellazione file
        const statusUrl = rec.getStatus?.()?.url || null;
        const directUri = rec.uri || null;
        tempUriRef.current = statusUrl || directUri || tempUriRef.current;
      } catch {}
      try {
        rec.release?.();
      } catch {}
      recorderRef.current = null;
    }

    // Passa la audio session in modalità PLAYBACK-only per garantire
    // lo speaker (non l'earpiece) sulla frase di chiusura.
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      await setIsAudioActiveAsync(true);
    } catch {}

    // === PRESENZA VOCALE — Chiusura (v2, 2026-07-27) =================
    // Riproduzione BLOCCANTE della frase pre-registrata "Grazie per averlo
    // lasciato andare." PRIMA che l'orb inizi a scomparire. Sequenza
    // cerimoniale richiesta dall'utente (Opzione B):
    //   1) La stanza resta visibile e l'orb continua il suo respiro
    //   2) Koda pronuncia la frase di chiusura (~1.5s) dallo SPEAKER
    //   3) SOLO al termine del playback parte l'animazione di uscita
    //
    // Se il playback fallisce o timeouta (safety 5s nel modulo helper),
    // proseguiamo comunque con l'uscita — non blocchiamo mai l'utente.
    try {
      await playClosePhrase(voiceKey);
    } catch (e) {
      console.warn("[LasciaAndare] close phrase failed:", e);
    }

    // === ANIMAZIONE DI USCITA (1.2s) ==================================
    // L'orb si rimpicciolisce lentamente verso il centro e sparisce nel
    // nero. Comunica visivamente che quello che è stato detto sparisce
    // davvero. Poi navighiamo indietro.
    await new Promise<void>((resolve) => {
      Animated.parallel([
        Animated.timing(orbEntryScale, {
          toValue: 0,
          duration: EXIT_DURATION_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(orbOpacity, {
          toValue: 0,
          duration: EXIT_DURATION_MS,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(hintOpacity, {
          toValue: 0,
          duration: 500,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start(() => resolve());
    });

    // Teardown risorse (file tmp, audio session) DOPO che l'animazione
    // è finita. Il recorder è già stato fermato/rilasciato sopra.
    await teardown();

    // router.back() se possibile, altrimenti torna alla home.
    // Il layout di expo-router applica il fade tra route (screenOptions
    // { animation: "fade" } in _layout.tsx) → il ritorno alla schermata
    // principale è quindi già fluido di suo.
    try {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace("/");
      }
    } catch {
      router.replace("/");
    }
  }, [router, teardown, orbEntryScale, orbOpacity, hintOpacity, voiceScale, voiceKey]);

  // === RENDER ==========================================================
  // Se non ancora autorizzato (in verifica) o negato (transitorio prima
  // del replace verso /paywall) → schermo nero minimo, nessun contenuto
  // sensibile né interazione. Questo è il gate visivo del Livello 2+3.
  if (authorized !== "allowed") {
    return <View style={[styles.root, { backgroundColor: "#000000" }]} />;
  }

  return (
    <View style={styles.root}>
      {/* Uscita — pulsante discreto in alto a sinistra.
          Touch target 44×44 (linee guida iOS), icona X neutra. */}
      <TouchableOpacity
        onPress={handleExit}
        hitSlop={16}
        style={[
          styles.exitBtn,
          { top: Math.max(insets.top + 8, 20) },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Esci da Lascia andare"
        testID="lascia-andare-exit"
      >
        <Ionicons name="close" size={22} color="rgba(255,255,255,0.55)" />
      </TouchableOpacity>

      {/* Orb centrale.
          - "idle" → respiro lento, palette calda
          - "recording" → tiffany freddo, luce che si "raffredda"
          Nessun testo intorno: silenzio visivo per silenzio uditivo.

          Transform combinato: entryScale × breathScale × voiceScale.
          - entryScale (0.3→1.0): animazione d'ingresso / d'uscita
          - breathScale (1.0↔1.05): respiro base continuo
          - voiceScale (1.0↔1.12): pulsazione con la voce dell'utente */}
      <View style={styles.center}>
        <Animated.View
          style={{
            opacity: orbOpacity,
            transform: [
              {
                scale: Animated.multiply(
                  orbEntryScale,
                  Animated.multiply(breathScale, voiceScale)
                ),
              },
            ],
          }}
        >
          <EclipseOrb
            status={status}
            size={260}
            meterDb={meterDb}
            meterThreshold={SPEECH_DB}
          />
        </Animated.View>
      </View>

      {/* Micro-hint in basso — fade-in ritardato di 1.8s dopo l'ingresso.
          Rassicura l'utente: "sto ascoltando, ma non ti sto registrando
          per rispondere". */}
      <Animated.View
        style={[
          styles.hintBox,
          { bottom: Math.max(insets.bottom + 24, 32), opacity: hintOpacity },
        ]}
      >
        {permError ? (
          <Text style={styles.errText}>{permError}</Text>
        ) : (
          <Text style={styles.hintText}>
            {ready ? "Nessuno ti sente. Sparisce nel silenzio." : ""}
          </Text>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
    justifyContent: "center",
    alignItems: "center",
  },
  exitBtn: {
    position: "absolute",
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  hintBox: {
    position: "absolute",
    left: 24,
    right: 24,
    alignItems: "center",
  },
  hintText: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 13,
    letterSpacing: 0.3,
    textAlign: "center",
    fontStyle: "italic",
  },
  errText: {
    color: "rgba(255,120,120,0.85)",
    fontSize: 13,
    textAlign: "center",
    letterSpacing: 0.2,
  },
});
