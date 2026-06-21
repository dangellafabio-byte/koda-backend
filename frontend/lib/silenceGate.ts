/**
 * SILENCE GATE — Server-side Silero VAD pre-flight check
 * ──────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE:
 *   Plan C (Fabio escalation 2026-06-20 v8).
 *   La VAD volumetrica in voice.ts decide "c'è voce" basandosi solo
 *   sull'RMS del microfono. Nel furgone col motore acceso, l'RMS è
 *   alto a prescindere → falsi positivi → Koda risponde a rumore di
 *   strada/clacson/motore → spreca Deepgram + Claude + ElevenLabs +
 *   l'attenzione dell'utente.
 *
 *   Questa gate (zero rischio nativo, gira sul backend Python via HTTP)
 *   chiede al modello Silero v5.1 — già validato sui memo del furgone
 *   di Fabio (speech_prob_max=0.9996, speech_ratio=0.49 col motore
 *   acceso) — se l'audio appena registrato contiene ALMENO un po' di
 *   parlato umano. Se Silero dice "no, è solo rumore", short-circuit
 *   prima di toccare le API esterne.
 *
 * SAFE-FALLBACK: se Silero non risponde (rete giù, backend lento,
 * timeout), assumiamo "c'è voce" e proseguiamo come prima. Meglio una
 * chiamata STT sprecata che una voce persa.
 *
 * KILL-SWITCH: profile.settings.silero_gate_enabled === false → bypass
 * totale, comportamento pre-Plan-C identico a prima.
 */
import { Platform } from "react-native";

const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  process.env.EXPO_BACKEND_URL ||
  "";

export type SileroProbeResult = {
  model: string;
  duration_s: number;
  original_sr: number;
  total_frames: number;
  speech_frames: number;
  speech_ratio: number;
  speech_prob_mean: number;
  speech_prob_max: number;
  segments: { start_s: number; end_s: number; peak_prob: number }[];
  threshold: number;
  inference_ms: number;
  decode_ms: number;
};

export type GateDecision = {
  /** true se l'audio deve essere processato (default safe). */
  hasSpeech: boolean;
  /** etichetta diagnostica leggibile per log/UI. */
  reason:
    | "silero-confirmed"
    | "silero-rejected"
    | "fallback-no-backend-url"
    | "fallback-no-audio-data"
    | "fallback-disabled"
    | "fallback-http-error"
    | "fallback-network-error"
    | "fallback-timeout";
  /** dettaglio numerico da Silero se la chiamata è riuscita. */
  probe: SileroProbeResult | null;
  /** millisecondi totali del round-trip (per [KODA_TIMING]). */
  latency_ms: number;
};

export type CheckOpts = {
  uri?: string;
  blob?: Blob;
  mime: string;
  filename: string;
  /** soglia speech_ratio sotto la quale è "no voce". Default 0.15 — calibrato sui memo di Fabio:
   *  - silenzio: 0.00
   *  - rumore motore: 0.00
   *  - voce in furgone motore acceso: 0.49
   *  → 0.15 è un margine prudente che evita falsi negativi (parole brevi/sussurri). */
  threshold?: number;
  /** timeout massimo per la chiamata. Default 3500ms — sufficiente per audio fino a ~15s. */
  timeoutMs?: number;
  /** se false, la gate è bypassata (decisione = "hasSpeech: true"). */
  enabled?: boolean;
};

/**
 * Esegue il pre-flight check su un audio registrato.
 * Non lancia mai eccezioni: in caso di errore restituisce un fallback safe
 * ({hasSpeech: true}) così il chiamante può proseguire normalmente.
 */
export async function checkHasSpeech(opts: CheckOpts): Promise<GateDecision> {
  const start = Date.now();
  const threshold = opts.threshold ?? 0.15;
  const timeoutMs = opts.timeoutMs ?? 3500;
  const enabled = opts.enabled !== false; // default ON

  if (!enabled) {
    return {
      hasSpeech: true,
      reason: "fallback-disabled",
      probe: null,
      latency_ms: 0,
    };
  }
  if (!BACKEND_URL) {
    return {
      hasSpeech: true,
      reason: "fallback-no-backend-url",
      probe: null,
      latency_ms: 0,
    };
  }
  if (!opts.uri && !opts.blob) {
    return {
      hasSpeech: true,
      reason: "fallback-no-audio-data",
      probe: null,
      latency_ms: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fd = new FormData();
    if (opts.blob) {
      fd.append("file", opts.blob, opts.filename);
    } else if (opts.uri) {
      // React Native FormData accetta {uri, name, type} per file upload.
      // @ts-ignore
      fd.append("file", {
        uri: opts.uri,
        name: opts.filename,
        type: opts.mime,
      });
    }

    // threshold=0.5 sui SINGOLI frame (default Silero). Il nostro threshold
    // a 0.15 è sul SPEECH_RATIO aggregato (% di frame >0.5). Sono cose
    // diverse: per_frame_threshold dice "questo frame è voce?", ratio_threshold
    // dice "abbastanza frame del clip sono voce?".
    const r = await fetch(
      `${BACKEND_URL}/api/vad/probe?threshold=0.5`,
      {
        method: "POST",
        body: fd,
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (!r.ok) {
      return {
        hasSpeech: true,
        reason: "fallback-http-error",
        probe: null,
        latency_ms: Date.now() - start,
      };
    }

    const probe = (await r.json()) as SileroProbeResult;
    const hasSpeech = (probe.speech_ratio ?? 0) >= threshold;
    return {
      hasSpeech,
      reason: hasSpeech ? "silero-confirmed" : "silero-rejected",
      probe,
      latency_ms: Date.now() - start,
    };
  } catch (e: any) {
    clearTimeout(timer);
    const isAbort = e?.name === "AbortError";
    return {
      hasSpeech: true,
      reason: isAbort ? "fallback-timeout" : "fallback-network-error",
      probe: null,
      latency_ms: Date.now() - start,
    };
  }
}

/**
 * Helper di log uniformato — emette una riga grep-abile su /diagnostics.
 * Esempio: [KODA_VAD_GATE] decision=PASS ratio=0.62 prob_max=0.99 latency=180ms reason=silero-confirmed
 */
export function logGateDecision(dec: GateDecision): void {
  const decision = dec.hasSpeech ? "PASS" : "BLOCK";
  const ratio = dec.probe?.speech_ratio?.toFixed(3) ?? "n/a";
  const probMax = dec.probe?.speech_prob_max?.toFixed(3) ?? "n/a";
  const segs = dec.probe?.segments?.length ?? 0;
  console.log(
    `[KODA_VAD_GATE] decision=${decision} ratio=${ratio} prob_max=${probMax} segments=${segs} latency=${dec.latency_ms}ms reason=${dec.reason} (platform=${Platform.OS})`
  );
}
