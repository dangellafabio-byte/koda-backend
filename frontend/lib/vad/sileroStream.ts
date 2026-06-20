/**
 * Silero Stream Engine — orchestratore microfono → VAD inference
 * ──────────────────────────────────────────────────────────────────────
 * P1 Fase 2 (Fabio escalation 2026-06-20).
 *
 * Riceve PCM Float32 samples a 16kHz dal microfono (via @siteed/audio-studio
 * con streamFormat='float32'), li bufferizza, e ogni 512 samples (32ms)
 * fa inference Silero → voice_probability.
 *
 * Detection eventi speech_start / speech_end con isteresi:
 *   - Soglia ON: prob > 0.5 per >= MIN_SPEECH_FRAMES (default 3 → 96ms)
 *   - Soglia OFF: prob < 0.35 per >= MIN_SILENCE_FRAMES (default 15 → 480ms)
 * Doppia soglia (Schmitt trigger) evita flickering tra frame borderline.
 *
 * ⚠️ Questo NON sostituisce ancora il VAD volumetrico nell'app reale.
 * È usato SOLO dalla pagina /diagnostics-vad per validazione PoC.
 * La sostituzione vera = P1 Fase 3.
 */

import { runVadInference, CHUNK_SIZE, isVadLoaded } from "./silero";

const ON_THRESHOLD = 0.5;
const OFF_THRESHOLD = 0.35;
const MIN_SPEECH_FRAMES = 3;     // 3 * 32ms = 96ms di voce continua per "speech_start"
const MIN_SILENCE_FRAMES = 15;   // 15 * 32ms = 480ms di silenzio per "speech_end"

export type StreamCallbacks = {
  /** Chiamato a ogni inferenza (~30Hz). Per UI live + sparkline. */
  onProbability?: (prob: number, rmsDb: number) => void;
  /** Chiamato quando un nuovo speech segment inizia. */
  onSpeechStart?: () => void;
  /** Chiamato quando finisce. */
  onSpeechEnd?: (durationMs: number) => void;
  /** Errori di inference (chunk skippato — non fatale). */
  onError?: (err: Error) => void;
};

export class SileroStreamEngine {
  private buffer: Float32Array = new Float32Array(0);
  private cb: StreamCallbacks;
  private active = false;
  private inSpeech = false;
  private speechFrames = 0;
  private silenceFrames = 0;
  private speechStartMs = 0;
  private inferenceInFlight = false;

  // Stats per UI
  public totalFrames = 0;
  public totalSpeechSegments = 0;
  public lastProb = 0;
  public lastRmsDb = -100;

  constructor(callbacks: StreamCallbacks = {}) {
    this.cb = callbacks;
  }

  /** Inizia a processare. La sessione VAD deve essere già caricata. */
  start() {
    if (!isVadLoaded()) {
      throw new Error("Silero VAD model not loaded — call loadSileroVadModel() before start()");
    }
    this.active = true;
    this.buffer = new Float32Array(0);
    this.inSpeech = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.totalFrames = 0;
    this.totalSpeechSegments = 0;
  }

  stop() {
    this.active = false;
    if (this.inSpeech) {
      const dur = Date.now() - this.speechStartMs;
      this.inSpeech = false;
      this.cb.onSpeechEnd?.(dur);
    }
    this.buffer = new Float32Array(0);
  }

  /**
   * Feed di samples dal microfono. La libreria audio-studio emette chunks
   * di lunghezza variabile (tipicamente 1600 @ 100ms). Li accumuliamo e
   * processiamo ogni volta che abbiamo >= CHUNK_SIZE samples disponibili.
   */
  async feedSamples(samples: Float32Array): Promise<void> {
    if (!this.active) return;

    // Concat samples nel buffer interno
    const newBuf = new Float32Array(this.buffer.length + samples.length);
    newBuf.set(this.buffer);
    newBuf.set(samples, this.buffer.length);
    this.buffer = newBuf;

    // Processa tutti i chunk pieni disponibili
    while (this.buffer.length >= CHUNK_SIZE && !this.inferenceInFlight) {
      const chunk = this.buffer.slice(0, CHUNK_SIZE);
      this.buffer = this.buffer.slice(CHUNK_SIZE);
      await this.processChunk(chunk);
    }
  }

  private async processChunk(chunk: Float32Array): Promise<void> {
    this.inferenceInFlight = true;
    try {
      const prob = await runVadInference(chunk);

      // RMS in dB per UI debug (per separare "VAD pensa silenzio" da
      // "microfono completamente muto"). Range tipico: -60dB silenzio,
      // -20dB voce normale, 0dB clipping.
      let rms = 0;
      for (let i = 0; i < chunk.length; i++) rms += chunk[i] * chunk[i];
      rms = Math.sqrt(rms / chunk.length);
      const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;

      this.lastProb = prob;
      this.lastRmsDb = rmsDb;
      this.totalFrames += 1;
      this.cb.onProbability?.(prob, rmsDb);

      // === Schmitt trigger per speech_start / speech_end ===
      if (!this.inSpeech) {
        if (prob > ON_THRESHOLD) {
          this.speechFrames += 1;
          this.silenceFrames = 0;
          if (this.speechFrames >= MIN_SPEECH_FRAMES) {
            this.inSpeech = true;
            this.speechStartMs = Date.now();
            this.totalSpeechSegments += 1;
            this.cb.onSpeechStart?.();
          }
        } else {
          this.speechFrames = 0;
        }
      } else {
        if (prob < OFF_THRESHOLD) {
          this.silenceFrames += 1;
          this.speechFrames = 0;
          if (this.silenceFrames >= MIN_SILENCE_FRAMES) {
            const dur = Date.now() - this.speechStartMs;
            this.inSpeech = false;
            this.silenceFrames = 0;
            this.cb.onSpeechEnd?.(dur);
          }
        } else {
          this.silenceFrames = 0;
        }
      }
    } catch (e: any) {
      this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.inferenceInFlight = false;
    }
  }
}

/** Helper per parsare il base64 PCM 16-bit in Float32Array [-1,1]. */
export function pcm16BeBase64ToFloat32(b64: string): Float32Array {
  // Decode base64 → Uint8Array
  // NB: usiamo atob globale (presente in RN nativo via polyfill expo).
  const binary = globalThis.atob ? globalThis.atob(b64) : "";
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  // Reinterpreta come Int16 little-endian (formato standard PCM16)
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768.0;
  return out;
}
