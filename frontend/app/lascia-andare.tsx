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
  Alert,
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
import * as SecureStore from "expo-secure-store";
import EclipseOrb, { OrbStatus } from "../components/EclipseOrb";
import {
  playOpenPhrase,
  playClosePhrase,
  playFirstBootIntroSequence,
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
// === COSTANTI PULSAZIONE VOCE — RIMOSSE (Punto 5, Fabio 2026-08-17) =========
// VOICE_PULSE_PEAK / VOICE_PULSE_HALF_CYCLE_MS / VOICE_RELEASE_MS erano
// per il vecchio loop discreto 1.0↔1.22 pilotato da `status`. Sostituito
// dal mappaggio dB→scale continuo (vedi useEffect [meterDb] più sotto).
// Range nuovo: 1.00→1.30, attack 180ms, release 500ms (release conservato
// come letterale nel nuovo useEffect, non più costante globale).

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
  const params = useLocalSearchParams<{ voice?: string; firstBoot?: string }>();
  const voiceKey = (params?.voice as string) || "aria";
  // === HEART REVEAL WATCHER (Fabio 2026-08-22) =============================
  // Se arriviamo da /intro-v3 con firstBoot=1, attiviamo il watcher per il
  // reveal della voce (fase C del piano):
  //   • min 60s garantiti di sessione (sotto → uscita normale via X)
  //   • dopo 60s: silenzio continuo ≥15s O tocco X → triggerReveal()
  //   • trigger → router.replace("/heart-voice-reveal")
  // Dalla 2ª apertura in poi (firstBoot assente) il watcher NON parte.
  const isFirstBoot = params?.firstBoot === "1";
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
  // === GATE INTRO V3 (Fabio 2026-08-23) ==================================
  // Se `intro_v3_completed_at` non è in SecureStore → l'utente non ha
  // MAI visto la sequenza narrativa → non deve atterrare qui, va inviato
  // a /intro-v3. Questo copre lo scenario in cui iOS ripristina la
  // sessione precedente direttamente su /lascia-andare (senza passare
  // dalla Home = pathname="/") → il router V3 in index.tsx non fire e
  // l'utente vede "Prenditi il tuo tempo" al posto della sequenza intro.
  //
  // Stati:
  //   "checking"    → sto leggendo SecureStore (blocca il render/audio)
  //   "authorized"  → intro completata OK, LA può partire
  //   "redirecting" → intro assente, sto reindirizzando (blocca il render/audio)
  const [introGate, setIntroGate] = useState<"checking" | "authorized" | "redirecting">("checking");

  // === GATE INTRO V3 — check anticipato (Fabio 2026-08-23) =================
  // Fire subito al mount, PRIMA che parta l'audio o qualsiasi setup mic.
  // Se intro_v3_completed_at manca → router.replace("/intro-v3") e blocca
  // il render (introGate="redirecting" → early return in JSX).
  // Questo copre lo scenario post-TestFlight in cui iOS ha ripristinato la
  // sessione direttamente su /lascia-andare senza passare dalla Home.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const flag = await SecureStore.getItemAsync("intro_v3_completed_at");
        if (cancelled) return;
        if (!flag) {
          console.log(`[KODA_LA_GATE] intro_v3_completed_at ASSENTE → redirect a /intro-v3`);
          setIntroGate("redirecting");
          try {
            router.replace("/intro-v3");
          } catch (e) {
            console.warn(`[KODA_LA_GATE] router.replace failed:`, e);
            // Fallback: se il router fallisce, permetti comunque LA
            setIntroGate("authorized");
          }
          return;
        }
        console.log(`[KODA_LA_GATE] intro_v3_completed_at presente → LA authorized`);
        setIntroGate("authorized");
      } catch (e) {
        console.warn(`[KODA_LA_GATE] SecureStore read failed (proceed with LA):`, e);
        if (!cancelled) setIntroGate("authorized");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === LIVELLO 2+3 GUARD → RIMOSSO (Punto 3, Fabio 2026-08-17) ============  // Ex "checking → allowed/denied" con network fetch al mount. Ora Lascia
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
    // === FIRMA DI VERSIONE (Fabio 2026-08-20) ==============================
    // Log di mount con marcatori espliciti dei fix Punti 5+7. Prefisso
    // KODA_ per essere catturato dal diagLogger (che filtra su [KODA_...]).
    // Serve a distinguere in un diag se la build in uso contiene o meno
    // il nuovo codice — evita l'ambiguità che ha causato la confusione
    // sul buildtag il 2026-08-20.
    console.log(
      "[KODA_LA_MOUNT] lascia-andare screen mounted — fixes=P3v2+P5+P7+P1b+P2 " +
        `defaultAuthorized=allowed cleanupPrefix=KODA_LA_CLEANUP orbReactive=meterDb ` +
        `voiceGlow=0.65-1.00@180/500ms dbBoost→EclipseOrb(internal) splashSkipOnRemount=on`
    );

    let cancelled = false;
    (async () => {
      try {
        const dir = (FileSystem as any).cacheDirectory as string | null;
        if (!dir) {
          console.log("[KODA_LA_CLEANUP] cacheDirectory unavailable — skip");
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
            console.log(`[KODA_LA_CLEANUP] skip ${name}: ${e}`);
          }
        }
        console.log(
          `[KODA_LA_CLEANUP] preemptive m4a orphans: deleted=${deleted} skipped=${skipped}`
        );
      } catch (e) {
        // readDirectoryAsync può fallire su alcuni device — non blocchiamo
        console.log(`[KODA_LA_CLEANUP] scan failed (non-fatal): ${e}`);
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
  // === PUNTO 1 D5+D6 (Fabio 2026-08-20) — MODULAZIONE OPACITY DA meterDb ===
  // voiceGlow: 0.65 (silenzio) → 1.00 (voce forte). Stessa cadenza temporale
  // di voiceScale (180ms attack / 500ms release) per coerenza sensoriale
  // — le due dimensioni si muovono in sincrono e sembrano una sola presenza.
  // Init = 0.65 così l'ingresso è dolce (già "sotto tono") e si accende
  // naturalmente al primo parlato dell'utente.
  const voiceGlow = useRef(new Animated.Value(0.65)).current;
  const hintOpacity = useRef(new Animated.Value(0)).current;
  // === PILL "PARLA CON KODA" (Fabio 2026-08-22) — Fase F del piano V3 =====
  // Mostrata SOLO dai boot ≥ 2 (intro_v3_completed_at presente E firstBoot
  // assente). Fade-in a 3s dal mount. Tap → rate-limit check → /microdemo
  // o /paywall?variant=post-demo. Semi-trasparente, non aggressiva.
  const [showPill, setShowPill] = useState<boolean>(false);
  const pillOpacity = useRef(new Animated.Value(0)).current;
  // Guard uscita: se l'uscita è già iniziata NON riavviamo animazioni
  const exitingRef = useRef(false);

  // === SPEC 2026-08-21 (Fabio) — FIRSTBOOT NARRATIVE GATE ===================
  // Nel primo boot (params.firstBoot === "1") l'ingresso in LA riproduce
  // in successione le due clip narrative "Questo è il mio cuore…" +
  // "Provalo." (vedi lib/lasciaAndareVoice.ts::playFirstBootIntroSequence).
  // Durante queste 2 clip:
  //   • Il pulsante X è NASCOSTO (non visibile, non toccabile)
  //   • Il mic NON è attivo (recorder non ancora inizializzato)
  //   • L'orb è visibile ma in stato calmo (speaking → warm palette)
  // Solo a fine 2ª clip il gate si apre: X appare, recorder parte, watcher
  // di silenzio per il reveal parte. Nei boot ≥ 2, il gate parte già "open"
  // e il comportamento è quello classico (playOpenPhrase → recorder).
  const [firstBootGate, setFirstBootGate] = useState<"playing" | "open">(
    isFirstBoot ? "playing" : "open"
  );
  const firstBootGateOpenRef = useRef<boolean>(!isFirstBoot);

  // === HEART REVEAL WATCHER — refs & state (Fabio 2026-08-22) ==============
  // Semantica:
  //   sessionStartedAt = timestamp mount (per calcolare min-60s garantiti)
  //   lastSpeechAt     = ultimo timestamp in cui meterDb > SPEECH_DB
  //   revealTriggered  = flag one-shot, evita re-trigger su remount
  // Watcher interval (500ms) attivo SOLO se isFirstBoot=true.
  const sessionStartedAtRef = useRef<number>(Date.now());
  const lastSpeechAtRef = useRef<number>(Date.now());
  const revealTriggeredRef = useRef<boolean>(false);
  const revealWatcherRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const MIN_SESSION_MS = 60_000;      // min 60s garantiti prima del reveal
  const SILENCE_FOR_REVEAL_MS = 15_000; // 15s silenzio continuo → trigger

  // Naviga al reveal della voce (chiamata da X o dal silence-watcher)
  const triggerHeartReveal = useCallback(() => {
    if (revealTriggeredRef.current) return;
    revealTriggeredRef.current = true;
    console.log(`[KODA_LA_REVEAL] trigger heart-voice-reveal after ${((Date.now() - sessionStartedAtRef.current) / 1000).toFixed(1)}s`);
    if (revealWatcherRef.current) {
      clearInterval(revealWatcherRef.current);
      revealWatcherRef.current = null;
    }
    // Fade-out orb morbido → naviga
    exitingRef.current = true;
    Animated.parallel([
      Animated.timing(orbOpacity, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.timing(orbEntryScale, {
        toValue: 0.3,
        duration: 500,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      // Teardown recorder prima della navigazione (evita fuga microfono)
      teardown().finally(() => {
        try {
          router.replace("/heart-voice-reveal");
        } catch (e) {
          console.warn("[KODA_LA_REVEAL] navigation failed:", e);
        }
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbOpacity, orbEntryScale, router]);

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

  // === PULSAZIONE VOCE — reattiva al dB continuo (Punto 5, Fabio 2026-08-17) ===
  // Il meterDb viene aggiornato ogni 100ms dal polling attivo (vedi il
  // setInterval al mount ~linea 585). Qui mappiamo il dB continuo a una
  // scala continua dell'orb, sostituendo il vecchio loop discreto 1.0↔1.22.
  //
  // Mappaggio:
  //   dB clamp     [-60 … -20]
  //   normalizzato [0 … 1]
  //   targetScale  [1.00 … 1.30]  (breathScale a parte fa 1.0↔1.05 di suo,
  //                                quindi 1.30 è chiaramente sopra baseline)
  //
  // Curva temporale (isteresi sulla direzione, non sul valore):
  //   - meterDb >= SILENCE_DB   → attack 180ms (voce sale rapidamente)
  //   - meterDb <  SILENCE_DB   → release 500ms (silenzio, rilascio naturale)
  //   Easing.out(Easing.quad)   → rallenta verso il target, coerente col respiro
  //
  // Perché sostituzione e non aggiunta:
  //   Due useEffect che toccano lo stesso Animated.Value creerebbero race.
  //   Il vecchio useEffect [status] pilotava un loop; ora `voiceScale` è
  //   funzione monotona di `meterDb`. Zero timer discreti che possono
  //   desincronizzarsi.
  //
  // Perché non è "teatrale":
  //   Range 1.00→1.30 (proposta approvata da Fabio). Ampiezza sufficiente per
  //   distinguere voce calma (~1.15) da voce intensa (~1.26) senza sconfinare
  //   in "equalizzatore musicale". Silenzio → 1.00 esatto, breathScale
  //   continua a fare il minimo respiro (invariato per scelta esplicita:
  //   "il silenzio è intenzionale, non un vuoto da riempire").
  //
  // Nota su `status`:
  //   Rimane pilotato dal VAD (setStatus in polling) per compatibilità con
  //   altri useEffect a valle (es. eventuali guard futuri), ma NON è più
  //   il pilota di `voiceScale`. In pratica in Lascia Andare `status` resta
  //   fisso a "recording" per design (fix v64.1).
  useEffect(() => {
    if (exitingRef.current) return; // durante l'uscita non tocchiamo la voce

    // Clamp del dB: -60 (silenzio pieno) … -20 (voce molto forte / urlo)
    const clampedDb = Math.max(-60, Math.min(-20, meterDb));
    // Normalizza in [0, 1]
    const normalized = (clampedDb - (-60)) / 40;
    // Scala target in [1.00, 1.30]
    const targetScale = 1.0 + normalized * 0.30;

    // Isteresi sulla direzione temporale (attack veloce, release lento)
    const duration = meterDb < SILENCE_DB
      ? 500  // release: silenzio confermato → rilascio naturale
      : 180; // attack: c'è segnale vocale → reattivo ma non nervoso

    Animated.timing(voiceScale, {
      toValue: targetScale,
      duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

    // === PUNTO 1 D5+D6 — voiceGlow accoppiato a voiceScale ================
    // Stessa curva temporale (attack/release) e stesso easing → le due
    // dimensioni si muovono in sincrono. Range: 0.65 → 1.00 (D5 confermato
    // da Fabio: moderato, "reattività sì, teatralità no"). L'opacity finale
    // dell'orb sarà `orbOpacity * voiceGlow` (moltiplicazione nel JSX più
    // sotto) → durante l'ingresso `orbOpacity` domina (fade-in), a regime
    // `voiceGlow` modula la presenza in funzione della voce.
    const targetGlow = 0.65 + normalized * 0.35; // [0.65, 1.00]
    Animated.timing(voiceGlow, {
      toValue: targetGlow,
      duration, // stesso di voiceScale (D6)
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

    // === DIAGNOSTICA ORB (Fabio 2026-08-20) ============================
    // Log throttlato (1x/sec) del dB corrente + scala target. Serve a
    // capire in produzione se il polling metering è vivo e se l'orb
    // sta ricevendo segnale. Prefisso KODA_ per essere catturato dal
    // diagLogger. Throttling: log solo se dB cambia di ≥3 dal precedente
    // OR se sono passati > 1s dall'ultimo log (evita spam ogni 100ms).
    if (
      typeof (globalThis as any).__kodaLaLastLogDb === "undefined" ||
      Math.abs(meterDb - (globalThis as any).__kodaLaLastLogDb) >= 3 ||
      Date.now() - ((globalThis as any).__kodaLaLastLogTs || 0) > 1000
    ) {
      console.log(
        `[KODA_LA_ORB] meterDb=${meterDb.toFixed(1)} target=${targetScale.toFixed(3)} ` +
          `dur=${duration}ms silence=${meterDb < SILENCE_DB ? "Y" : "N"}`
      );
      (globalThis as any).__kodaLaLastLogDb = meterDb;
      (globalThis as any).__kodaLaLastLogTs = Date.now();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meterDb]);

  // === SETUP — chiamato al mount ======================================
  useEffect(() => {
    // === LIVELLO 2+3 GUARD ==============================================
    // Non chiediamo permessi microfono né inizializziamo il recorder
    // finché authorize non ha confermato l'accesso. Se denied, il
    // guard useEffect sopra ha già triggerato router.replace.
    if (authorized !== "allowed") return;
    // === GATE INTRO V3 (Fabio 2026-08-23) ==============================
    // Se non abbiamo verificato che l'utente ha completato la sequenza
    // narrativa V3, blocca il setup audio/mic. Fenomeno visto in TestFlight:
    // iOS ripristina la sessione direttamente su /lascia-andare senza
    // passare dalla Home → il router V3 non fire → LA parte comunque e
    // riproduce "Prenditi il tuo tempo" al posto della sequenza intro.
    if (introGate !== "authorized") return;

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
        //
        // === SPEC 2026-08-21 (Fabio) — SEQUENZA NARRATIVA FIRSTBOOT ===
        // Se params.firstBoot === "1", riproduciamo le due clip narrative
        // "Questo è il mio cuore…" + "Provalo." (BLOCCANTE, ~11s totali)
        // e SOSTITUIAMO la classica "Prenditi il tuo tempo". Durante
        // queste clip l'X è nascosto e il mic non è ancora attivo.
        // A fine sequenza si apre il gate → X visibile, recorder attivo.
        try {
          if (isFirstBoot) {
            console.log("[LasciaAndare] firstBoot=1 → play narrative sequence (cuore + provalo)");
            await playFirstBootIntroSequence();
          } else {
            await playOpenPhrase(voiceKey);
          }
        } catch (e) {
          console.warn("[LasciaAndare] open phrase failed:", e);
        }

        if (cancelled) return;

        // Apri il gate (X visibile + rende il mic pronto ad essere attivato)
        if (isFirstBoot && !firstBootGateOpenRef.current) {
          firstBootGateOpenRef.current = true;
          setFirstBootGate("open");
          // Reset baseline del watcher a POST-clip così i 60s di sessione
          // minima si contano dal momento in cui l'utente può realmente parlare
          sessionStartedAtRef.current = Date.now();
          lastSpeechAtRef.current = Date.now();
        }

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
              // === REVEAL WATCHER (Fabio 2026-08-22) ===
              // Aggiorna il timestamp di "ultimo parlato" per il silence
              // watcher del reveal (fase C del piano). Runs sempre, il
              // watcher stesso è gated da isFirstBoot.
              lastSpeechAtRef.current = now;
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
  }, [introGate]);

  // === Hardware back (Android) → uscita pulita ==========================
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleExitOrReveal();
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

  // === PILL "PARLA CON KODA" (Fabio 2026-08-22) ==============================
  // Check condizioni + fade-in + tap handler
  useEffect(() => {
    if (isFirstBoot) return; // primo boot: no pill (l'utente sta vivendo il reveal)
    let cancelled = false;
    (async () => {
      try {
        const introDone = await SecureStore.getItemAsync("intro_v3_completed_at");
        if (cancelled) return;
        if (!introDone) return; // se intro v3 non è completata, non mostrare
        // Fade-in a 3s dal mount, non aggressiva
        setTimeout(() => {
          if (cancelled) return;
          setShowPill(true);
          Animated.timing(pillOpacity, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }).start();
        }, 3000);
      } catch {
        // silenzioso, no pill se SecureStore fallisce
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFirstBoot]);

  const onPillTap = useCallback(async () => {
    console.log(`[KODA_LA_PILL] tap Parla con Koda`);
    try {
      const lastAtStr = await SecureStore.getItemAsync("microdemo_last_at");
      const lastAt = lastAtStr ? parseInt(lastAtStr, 10) : 0;
      const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      if (lastAt && now - lastAt < RATE_LIMIT_MS) {
        // Fuori rate-limit → paywall diretto
        console.log(`[KODA_LA_PILL] rate-limited → paywall`);
        router.push("/paywall?variant=post-demo");
        return;
      }
      // Ok → naviga alla demo
      router.push("/microdemo");
    } catch (e) {
      console.warn(`[KODA_LA_PILL] tap handler failed:`, e);
    }
  }, [router]);

  // === HANDLE EXIT-OR-REVEAL (Fabio 2026-08-22) ============================
  // Wrapper: nel PRIMO BOOT (firstBoot=1), se l'utente tocca X dopo
  // ≥60s → triggerHeartReveal (fase C). Altrimenti (sessione < 60s O
  // NON firstBoot) → handleExit normale.
  // Motivo: non forziamo l'utente al reveal se ha appena aperto la stanza
  // e vuole uscire subito (edge case: click accidentale).
  const handleExitOrReveal = useCallback(() => {
    if (isFirstBoot && !revealTriggeredRef.current) {
      const elapsed = Date.now() - sessionStartedAtRef.current;
      if (elapsed >= MIN_SESSION_MS) {
        console.log(`[KODA_LA_REVEAL] X tapped after ${(elapsed / 1000).toFixed(1)}s → trigger reveal`);
        triggerHeartReveal();
        return;
      }
      console.log(`[KODA_LA_REVEAL] X tapped early (${(elapsed / 1000).toFixed(1)}s < 60s) → normal exit`);
    }
    handleExit();
  }, [isFirstBoot, triggerHeartReveal, handleExit]);

  // === RIAVVIA SEQUENZA INTRO (Fabio 2026-08-22) ===========================
  // Gesture di reset: long-press di 1.5s sulla X in Lascia Andare
  // (poco frequente per errore, facile per test volontario).
  // Mostra un Alert di conferma; se confermato:
  //   1. Cancella tutti i flag SecureStore correlati all'onboarding V3
  //   2. Cancella lo splash-shown per uniformità di visualizzazione
  //   3. Fade-out + router.replace("/intro-v3") → parte tutta la sequenza
  //
  // Motivo del gesture nascosto: l'utente di test vuole poter ripetere
  // la sequenza narrativa più volte per valutarla, senza reinstallare
  // l'app. Non lo mettiamo come bottone visibile perché non è una
  // feature per l'end-user finale — è uno strumento di valutazione.
  const onLongPressExit = useCallback(() => {
    Alert.alert(
      "Rivedere l'introduzione?",
      "Riavvia dall'inizio la sequenza narrativa (saluto, nome, Lascia Andare, reveal della voce, demo). Serve per rivedere tutto come al primo boot.",
      [
        { text: "Annulla", style: "cancel" },
        {
          text: "Sì, riavvia",
          style: "destructive",
          onPress: async () => {
            console.log(`[KODA_LA_RESET] intro V3 reset triggered by user`);
            try {
              await Promise.all([
                SecureStore.deleteItemAsync("intro_v3_completed_at"),
                SecureStore.deleteItemAsync("heart_reveal_dismissed_at"),
                SecureStore.deleteItemAsync("microdemo_last_at"),
                SecureStore.deleteItemAsync("user_display_name"),
                // Anche il flag V1 (superato) per completezza
                SecureStore.deleteItemAsync("koda_intro_seen"),
                SecureStore.deleteItemAsync("koda_intro_completed_at"),
              ]);
              console.log(`[KODA_LA_RESET] flags cleared, navigating to /intro-v3`);
            } catch (e) {
              console.warn(`[KODA_LA_RESET] SecureStore clear failed (procedo comunque):`, e);
            }
            // Fade-out morbido → naviga
            exitingRef.current = true;
            Animated.timing(orbOpacity, {
              toValue: 0,
              duration: 400,
              useNativeDriver: true,
            }).start();
            // Teardown recorder + naviga
            teardown().finally(() => {
              try {
                router.replace("/intro-v3");
              } catch (e) {
                console.warn(`[KODA_LA_RESET] router.replace failed:`, e);
              }
            });
          },
        },
      ],
      { cancelable: true }
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, orbOpacity]);

  // === REVEAL SILENCE WATCHER (Fabio 2026-08-22) ==========================
  // Attivo SOLO se isFirstBoot. Ogni 500ms controlla:
  //   Date.now() - sessionStartedAt >= 60_000 AND
  //   Date.now() - lastSpeechAt      >= 15_000
  // → triggerHeartReveal(). One-shot (revealTriggeredRef guard).
  useEffect(() => {
    if (!isFirstBoot) return;
    // Reset baseline al mount (evita drift da eventuali remount)
    sessionStartedAtRef.current = Date.now();
    lastSpeechAtRef.current = Date.now();
    revealTriggeredRef.current = false;
    console.log(`[KODA_LA_REVEAL] watcher started (firstBoot=1, min=${MIN_SESSION_MS}ms, silence=${SILENCE_FOR_REVEAL_MS}ms)`);
    revealWatcherRef.current = setInterval(() => {
      if (revealTriggeredRef.current) return;
      const now = Date.now();
      const sessionElapsed = now - sessionStartedAtRef.current;
      const silenceElapsed = now - lastSpeechAtRef.current;
      if (sessionElapsed >= MIN_SESSION_MS && silenceElapsed >= SILENCE_FOR_REVEAL_MS) {
        console.log(`[KODA_LA_REVEAL] silence trigger — session=${(sessionElapsed / 1000).toFixed(1)}s silence=${(silenceElapsed / 1000).toFixed(1)}s`);
        triggerHeartReveal();
      }
    }, 500);
    return () => {
      if (revealWatcherRef.current) {
        clearInterval(revealWatcherRef.current);
        revealWatcherRef.current = null;
      }
    };
  }, [isFirstBoot, triggerHeartReveal]);


  // === RENDER ==========================================================
  // Se non ancora autorizzato (in verifica) o negato (transitorio prima
  // del replace verso /paywall) → schermo nero minimo, nessun contenuto
  // sensibile né interazione. Questo è il gate visivo del Livello 2+3.
  if (authorized !== "allowed") {
    return <View style={[styles.root, { backgroundColor: "#000000" }]} />;
  }
  // === GATE INTRO V3 (Fabio 2026-08-23) ==================================
  // Se stiamo ancora verificando `intro_v3_completed_at` o abbiamo appena
  // triggerato il redirect a /intro-v3, mostra schermo nero (no audio, no
  // orb, no "Prenditi il tuo tempo"). Il redirect avviene nel useEffect
  // sopra, che ha già chiamato router.replace("/intro-v3").
  if (introGate !== "authorized") {
    return <View style={[styles.root, { backgroundColor: "#000000" }]} />;
  }

  return (
    <View style={styles.root}>
      {/* Uscita — pulsante discreto in alto a sinistra.
          Touch target 44×44 (linee guida iOS), icona X neutra.
          === SPEC 2026-08-21 (Fabio) — FIRSTBOOT GATE ===
          Nel primo boot la X è NASCOSTA finché non finisce la sequenza
          narrativa (clip cuore + provalo). Il flag `firstBootGate` diventa
          "open" a fine sequenza e la X appare (senza animazione: la comparsa
          coincide con "Provalo." → naturale). Nei boot ≥ 2 parte già "open". */}
      {firstBootGate === "open" && (
        <TouchableOpacity
          onPress={handleExitOrReveal}
          onLongPress={onLongPressExit}
          delayLongPress={1500}
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
      )}

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
            // === PUNTO 1 D5+D6 — opacity finale = entry × voiceGlow ========
            // orbOpacity gestisce il fade-in di ingresso e il fade-out di
            // uscita (0→1 all'entry, 1→0 all'exit). voiceGlow modula la
            // presenza dinamicamente in funzione del dB (0.65 silenzio →
            // 1.00 voce forte). La moltiplicazione è coerente sia durante
            // le transizioni sia a regime.
            opacity: Animated.multiply(orbOpacity, voiceGlow),
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
            /* === LASCIA ANDARE GLOW (Fabio 2026-08-22) ================
             * Boost normalizzato (0..1) derivato dal dB microfonico:
             *   dB clamp   [-60 … -20]   → boost [0 … 1]
             * Passa questo direttamente dentro EclipseOrb, che a sua volta
             * modula:
             *   - opacity dei layer aurora/rim/filamenti (0.45 → 1.0)
             *   - estensione outward dei filamenti (aurora "esce" di più)
             * Questo è ciò che rende visibile il glow: prima moltiplicavamo
             * l'opacity SOLO sul wrapper esterno (voiceGlow), ma i layer
             * interni erano fissi a 0.45 → il range percettivo era 0.29→0.45
             * (impercettibile). Ora il boost è APPLICATO DENTRO l'orb, sui
             * gradienti SVG reali → range percettivo 0.29→1.0 (chiaro). */
            dbBoost={Math.max(
              0,
              Math.min(1, (Math.max(-60, Math.min(-20, meterDb)) + 60) / 40)
            )}
          />
          {/* Spacer 34px per allineare l'orb alla stessa posizione della
              home (gap:18 + statusLabel 16px). Fabio 2026-08-23. */}
          <View style={{ height: 34 }} pointerEvents="none" />
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

      {/* Pill "Parla con Koda" — visibile solo dai boot ≥ 2 (fase F piano V3).
          Semi-trasparente, sopra il hint, fade-in a 3s. Non è aggressiva:
          l'utente può ignorarla e restare in LA all'infinito. Tap → demo
          se rate-limit ok, altrimenti paywall. */}
      {showPill && (
        <Animated.View
          style={[
            styles.pillBox,
            {
              bottom: Math.max(insets.bottom + 64, 80),
              opacity: pillOpacity,
            },
          ]}
          pointerEvents="box-none"
        >
          <TouchableOpacity
            onPress={onPillTap}
            style={styles.pillBtn}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Parla con Koda"
            testID="la-pill-parla-con-koda"
          >
            <Ionicons
              name="chatbubble-outline"
              size={14}
              color="rgba(255,255,255,0.7)"
              style={{ marginRight: 8 }}
            />
            <Text style={styles.pillText}>Parla con Koda</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
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
    // Allineamento pixel-perfect con home Page 0 (Fabio 2026-08-23):
    // stesso paddingTop del wrapper home (index.tsx riga ~5247) → l'orb
    // è ESATTAMENTE nella stessa posizione tra LA e home vera. NON
    // tocchiamo la size (260) — solo la posizione del centro.
    paddingTop: 90,
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
  // === PILL "PARLA CON KODA" (Fabio 2026-08-22) ==========================
  // Semi-trasparente, discreta. Sopra il hint. Non aggressiva.
  pillBox: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  pillBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  pillText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    letterSpacing: 0.4,
    fontWeight: "500",
  },
});
