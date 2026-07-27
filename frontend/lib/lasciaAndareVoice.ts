/**
 * lasciaAndareVoice.ts — playback delle frasi di presenza per la Stanza dello Sfogo.
 *
 * VINCOLO ARCHITETTURALE: la modalità "Lascia andare" ha rete zero durante
 * la sessione utente (nessun fetch, nessun WebSocket, nessuna chiamata a
 * ElevenLabs a runtime). Le frasi di apertura e chiusura sono quindi
 * pre-registrate e bundled con l'app tramite require() statico.
 *
 * Frasi (identiche per entrambe le voci — forma neutra):
 *   - Apertura: "Prenditi il tuo tempo."
 *   - Chiusura: "Grazie per averlo lasciato andare."
 *
 * File generati una volta con /app/frontend/scripts/generate-lascia-andare-audio.js
 * usando ElevenLabs Flash v2.5 + le stesse voci custom del path conversazionale
 * (Cielo POuqf18…, Vento ll9WG7P…).
 *
 * API:
 *   - playOpenPhrase(voice)  → Promise<void>  (risolve al termine playback)
 *   - playClosePhrase(voice) → Promise<void>  (risolve al termine playback)
 *   - stopAll()              → cancella eventuale playback in corso (idempotente)
 *
 * Ogni play crea un nuovo AudioPlayer (SharedObject) e lo rilascia via
 * remove() a fine playback, per non lasciare risorse audio pending.
 * Timeout di sicurezza a 5s (le frasi durano ~1-1.5s).
 */

import { createAudioPlayer, AudioPlayer } from "expo-audio";

// ============================================================================
// Bundle assets (require statico — Metro li impacchetta a build-time)
// ============================================================================
// Nota: NON usare percorsi dinamici tipo require(`../assets/sounds/${key}.mp3`)
// perché Metro NON risolve template literal a build-time.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const openCielo = require("../assets/sounds/lascia-andare/open-cielo.mp3");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const openVento = require("../assets/sounds/lascia-andare/open-vento.mp3");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const closeCielo = require("../assets/sounds/lascia-andare/close-cielo.mp3");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const closeVento = require("../assets/sounds/lascia-andare/close-vento.mp3");

// ============================================================================
// Mapping voice → asset
// ============================================================================
// La UI e il backend usano "aria" (Cielo, femminile) e "theo" (Vento,
// maschile) come chiavi canoniche (vedi app/index.tsx VOICE_ID_TO_KODA_VOICE
// e KodaIntro.tsx). Accettiamo anche gli alias storici "cielo"/"vento"/"echo"
// per robustezza. Fallback a Cielo se voce non riconosciuta o assente.
export type LasciaAndareVoice = "aria" | "theo" | "cielo" | "vento" | "echo" | string | null | undefined;

function pickOpenAsset(voice: LasciaAndareVoice) {
  const v = (voice || "").toString().toLowerCase();
  // "theo" è il valore canonico del backend per la voce maschile Vento
  if (v === "vento" || v === "echo" || v === "theo") return openVento;
  return openCielo; // default (aria/cielo/qualsiasi altro)
}

function pickCloseAsset(voice: LasciaAndareVoice) {
  const v = (voice || "").toString().toLowerCase();
  if (v === "vento" || v === "echo" || v === "theo") return closeVento;
  return closeCielo;
}

// ============================================================================
// Runtime state (singleton per teardown pulito)
// ============================================================================
let currentPlayer: AudioPlayer | null = null;

/**
 * Rilascia il player corrente in modo idempotente.
 * Chiamato al termine naturale del playback O forzatamente da stopAll().
 */
function releaseCurrent() {
  const p = currentPlayer;
  currentPlayer = null;
  if (!p) return;
  try {
    try { p.pause(); } catch {}
    // @ts-ignore - remove() esiste su AudioPlayer ma non sempre tipizzato
    if (typeof p.remove === "function") {
      // @ts-ignore
      p.remove();
    }
  } catch {}
}

/**
 * Play interno — crea un AudioPlayer, avvia il playback, e ritorna una
 * Promise che si risolve quando il playback termina (o timeout 5s).
 * Sostituisce eventuale player in corso.
 */
function playAndWait(source: number): Promise<void> {
  return new Promise((resolve) => {
    // Ferma eventuale playback precedente (raro: apertura+chiusura non
    // si sovrappongono mai, ma difensivo)
    releaseCurrent();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      releaseCurrent();
      resolve();
    };

    // Timeout hard di sicurezza (le frasi durano ~1-1.5s; 5s è abbondante)
    const safetyTimer = setTimeout(finish, 5000);

    try {
      const player = createAudioPlayer(source, { updateInterval: 100 });
      currentPlayer = player;

      // Listener sul playback: didJustFinish è l'unica via di completamento OK
      try {
        // @ts-ignore - addListener esiste ma il tipo può variare tra versioni
        player.addListener("playbackStatusUpdate", (st: any) => {
          if (done) return;
          if (st?.didJustFinish) {
            clearTimeout(safetyTimer);
            finish();
          }
        });
      } catch {}

      // Volume pieno (voce di Koda deve essere ben udibile)
      try {
        // @ts-ignore
        if (typeof player.volume === "number") {
          // @ts-ignore
          player.volume = 1.0;
        }
      } catch {}

      try {
        player.play();
      } catch (e) {
        console.warn("[lasciaAndareVoice] play() failed:", e);
        clearTimeout(safetyTimer);
        finish();
      }
    } catch (e) {
      console.warn("[lasciaAndareVoice] createAudioPlayer failed:", e);
      clearTimeout(safetyTimer);
      finish();
    }
  });
}

/**
 * Riproduce la frase di apertura ("Prenditi il tuo tempo.") con la voce
 * indicata. Ritorna quando l'audio termina naturalmente.
 */
export function playOpenPhrase(voice: LasciaAndareVoice): Promise<void> {
  return playAndWait(pickOpenAsset(voice));
}

/**
 * Riproduce la frase di chiusura ("Grazie per averlo lasciato andare.")
 * con la voce indicata. Ritorna quando l'audio termina naturalmente.
 */
export function playClosePhrase(voice: LasciaAndareVoice): Promise<void> {
  return playAndWait(pickCloseAsset(voice));
}

/**
 * Ferma qualsiasi playback in corso e rilascia le risorse.
 * Idempotente. Chiamato in cleanup di sicurezza durante teardown.
 */
export function stopAll(): void {
  releaseCurrent();
}
