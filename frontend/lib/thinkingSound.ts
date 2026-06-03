/**
 * Thinking sound — "Gentle Pause" jingle che parte quando Koda sta pensando
 * e si ferma appena Koda inizia a parlare.
 *
 * Idea: l'utente potrebbe non guardare il telefono mentre Koda elabora,
 * quindi serve un feedback uditivo discreto ma riconoscibile che dica
 * "Koda è ancora con te, sta arrivando".
 *
 * Asset: assets/sounds/thinking.wav (6s, scala pentatonica Re-Fa-Sol-Do,
 * timbro FM marimba/vetro, sottofondo caldo 85Hz, vedi backend generator).
 *
 * Loop nativo via `player.loop = true` (expo-audio). Singleton: solo un'istanza
 * alla volta. Volume conservativo (default 0.7) per non coprire pensieri.
 */

import { createAudioPlayer, AudioPlayer } from "expo-audio";

// Singleton: una sola istanza a runtime per evitare overlap se il flusso
// stati va "thinking" → "thinking" rapidamente (es. fallback dal fast path).
let player: AudioPlayer | null = null;
let isPlaying = false;

/**
 * Avvia il jingle. Idempotente: se già in riproduzione, no-op.
 */
export function startThinkingSound() {
  if (isPlaying) return;
  try {
    // require() di un asset locale viene risolto da Metro a runtime in
    // un oggetto con uri/.bundle interno; expo-audio lo accetta.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require("../assets/sounds/thinking.wav");
    player = createAudioPlayer(source, { updateInterval: 1000 });
    // Loop nativo: nessun gap tra una ripetizione e l'altra.
    try {
      // @ts-ignore - loop è una proprietà dinamica
      player.loop = true;
    } catch {}
    try {
      // @ts-ignore - alcuni player espongono volume direttamente
      if (typeof player.volume === "number") {
        // @ts-ignore
        player.volume = 0.7;
      }
    } catch {}
    player.play();
    isPlaying = true;
  } catch (e) {
    console.warn("[thinkingSound] start failed:", e);
    isPlaying = false;
  }
}

/**
 * Ferma il jingle e libera risorse. Idempotente.
 */
export function stopThinkingSound() {
  if (!isPlaying && !player) return;
  isPlaying = false;
  const p = player;
  player = null;
  if (!p) return;
  try {
    // Pause prima del release per chiudere la sessione audio in modo pulito.
    try { p.pause(); } catch {}
    try {
      // expo-audio: remove() rilascia la SharedObject sottostante.
      // @ts-ignore - remove esiste su AudioPlayer ma non sempre tipizzato
      if (typeof p.remove === "function") {
        // @ts-ignore
        p.remove();
      }
    } catch {}
  } catch (e) {
    console.warn("[thinkingSound] stop failed:", e);
  }
}
