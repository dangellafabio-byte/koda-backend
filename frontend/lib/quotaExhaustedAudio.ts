/**
 * quotaExhaustedAudio.ts
 * ======================
 * Gestisce la riproduzione del messaggio audio pre-registrato "minuti voce
 * esauriti" quando il backend risponde con HTTP 402 `paid_quota_exhausted`.
 *
 * Contratto:
 *  - Il messaggio è un asset MP3 statico nel bundle (
 *    /assets/audio/koda_quota_exhausted.mp3), pre-registrato via ElevenLabs
 *    Acqua Turbo v2.5. Testo definito con Fabio 2026-06.
 *  - Riprodotto UNA SOLA VOLTA per sessione (state module-level). I turni
 *    successivi mostrano solo la UI (banner viola + nessun audio) — evita
 *    che l'utente venga bombardato dallo stesso messaggio ogni volta che
 *    prova a parlare.
 *  - Setta il flag `sessionQuotaExhausted=true` che il router voce controlla
 *    per disattivare la pipeline STT/converse voice e forzare la chat scritta.
 *
 * Fallback: se l'asset non caricabile (bundle non aggiornato con l'MP3),
 * usiamo `expo-speech` con la stessa stringa — voce robotica ma comunque
 * comunica il concetto (fail-open).
 */
import { Audio } from "expo-av";
import * as Speech from "expo-speech";

// === STATO MODULE-LEVEL =====================================================
// Un solo flag per l'intera sessione app (reset al restart).
let _sessionQuotaExhausted = false;
let _audioPlayedThisSession = false;
let _cachedSound: Audio.Sound | null = null;

const FALLBACK_TEXT =
  "Hai finito i minuti voce di questo mese. La voce ha bisogno di minuti " +
  "che ora non hai più. Continuiamo in chat scritta, sono qui. " +
  "Se vuoi, aggiungi trenta minuti dalla home.";

/**
 * True se in questa sessione l'utente ha già ricevuto un 402 → il router
 * voce deve saltare la pipeline STT/converse e forzare la chat scritta.
 */
export function isQuotaExhaustedSession(): boolean {
  return _sessionQuotaExhausted;
}

/**
 * Reset esplicito — chiamato quando l'utente cambia tier o attiva un top-up
 * (il backend ritornerà `paid_state=active` alla prossima /profile refresh).
 */
export function resetQuotaExhaustedSession(): void {
  _sessionQuotaExhausted = false;
  _audioPlayedThisSession = false;
  if (_cachedSound) {
    try {
      _cachedSound.unloadAsync().catch(() => {});
    } catch {}
    _cachedSound = null;
  }
}

/**
 * Marca la sessione come "quota exhausted" e riproduce l'MP3 pre-registrato.
 * Idempotente: se già riprodotto in questa sessione, no-op sul playback.
 *
 * Il chiamante (voice router / converse handler) DEVE:
 *  1. chiamare questa funzione quando riceve 402 dal backend
 *  2. mostrare il banner viola "Minuti finiti" nella UI
 *  3. reindirizzare l'utente alla chat scritta (bloccare hands-free)
 */
export async function handleQuotaExhausted(): Promise<void> {
  _sessionQuotaExhausted = true;

  if (_audioPlayedThisSession) {
    return;
  }
  _audioPlayedThisSession = true;

  try {
    // Configura audio session per playback (rispetta silent mode iOS)
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      });
    } catch {}

    // Carica asset statico dal bundle
    const { sound } = await Audio.Sound.createAsync(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../assets/audio/koda_quota_exhausted.mp3"),
      { shouldPlay: true, volume: 1.0 }
    );
    _cachedSound = sound;

    // Auto-unload dopo playback per liberare memoria
    sound.setOnPlaybackStatusUpdate((status) => {
      if (
        status.isLoaded &&
        (status.didJustFinish ||
          (!status.isPlaying && status.positionMillis > 0 && status.durationMillis
            ? status.positionMillis >= status.durationMillis - 50
            : false))
      ) {
        sound.unloadAsync().catch(() => {});
        if (_cachedSound === sound) _cachedSound = null;
      }
    });
  } catch (e) {
    // Fallback: expo-speech con testo statico (voce robotica).
    // Zero costo, garantisce che l'utente riceva il messaggio anche se
    // l'MP3 non è nel bundle (build vecchia).
    console.warn(
      "[quotaExhausted] asset MP3 fallito, fallback expo-speech:",
      String(e).slice(0, 120)
    );
    try {
      Speech.stop();
    } catch {}
    try {
      Speech.speak(FALLBACK_TEXT, {
        language: "it-IT",
        rate: 1.0,
        pitch: 1.0,
      });
    } catch {}
  }
}

/**
 * Parsing helper: dato l'oggetto errore di jsonReq (throw new Error(`HTTP 402: ${msg}`)),
 * ritorna true se rappresenta un `paid_quota_exhausted`. Usato dai chiamanti
 * per decidere se invocare handleQuotaExhausted() o gestire diversamente.
 */
export function isQuotaExhaustedError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // jsonReq costruisce: `HTTP 402: {detail estratto}` (vedi lib/api.ts:180+).
  // Il detail può essere una stringa "paid_quota_exhausted" o l'oggetto
  // {"error":"paid_quota_exhausted",...} serializzato in JSON.
  return /HTTP 402|paid_quota_exhausted|Minuti voce esauriti/i.test(msg);
}
