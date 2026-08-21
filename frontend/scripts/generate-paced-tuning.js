/**
 * generate-paced-tuning.js
 *
 * FASE 2 dell'esplorazione paced.
 *
 * Base FISSA: speed = 0.74 ("molto lento" scelto dall'utente).
 * Obiettivo: trovare la combinazione di stability / style / [pause] / [breath] /
 *            prosodia che rende il rallentamento naturale e caldo — un cambio
 *            di ritmo della presenza di Koda, NON una voce artificialmente
 *            rallentata né una tecnica terapeutica.
 *
 * Criterio: deve dare spontaneamente la sensazione di
 *           "rallentiamo un attimo insieme", senza che Koda lo dichiari.
 *
 * Matrice di 10 sample, divisi in 3 famiglie:
 *
 *   A. BREVI CON [pause]         (P1, P2, P3)         → 3 sample
 *      Testo: "[softly] Aspetta. [pause] Piano. [pause] Ci sono."
 *      Variazione: stability × style. Base vs caldo vs composto.
 *
 *   B. BREVI CON [breath] NATURALE / SENZA BREATH  (P4, P5)  → 2 sample
 *      P4: un solo [breath] in apertura, poi [pause].
 *      P5: nessun breath, solo [softly] + punteggiatura ellittica.
 *      Serve a capire se il respiro udibile aggiunge presenza fisica
 *      oppure suona artificiale.
 *
 *   C. ARTICOLATI                (P6, P7, P8)         → 3 sample
 *      Testo: risposta più lunga (2 frasi + chiusura). Verifica che
 *      paced NON obblighi Koda a risposte brevissime.
 *      P6 base, P7 caldo, P8 con un solo [breath] iniziale.
 *
 *   D. CONFRONTO SIMILARITY      (P9, P10)            → 2 sample
 *      Stessi params di P1 ma similarity_boost estremi (0.90 vs 0.72)
 *      per capire quanto la "purezza" della voce Cielo influisca sulla
 *      sensazione di calore/presenza a velocità lenta.
 *
 * Totale: 10 sample.
 */

const fs = require("fs");
const path = require("path");

const VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7";
const MODEL_V3 = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";

const SPEED_BASE = 0.74;

// ============ TESTI ============
// A/D — brevi con [pause]
const TEXT_BREVE_PAUSE = "[softly] Aspetta. [pause] Piano. [pause] Ci sono.";

// B — brevi con [breath] singolo
const TEXT_BREVE_BREATH = "[breath] Aspetta. [pause] Piano. [pause] Ci sono.";

// B — breve senza breath, solo prosodia via ellissi
const TEXT_BREVE_NO_BREATH = "[softly] Aspetta... Piano... Ci sono.";

// C — articolato base (con [pause])
const TEXT_ARTICOLATO =
  "[softly] Aspetta un momento. [pause] Non serve andare veloci ora. [pause] Sono qui con te.";

// C — articolato con [breath] iniziale singolo
const TEXT_ARTICOLATO_BREATH =
  "[breath] Aspetta un momento. [pause] Non serve andare veloci ora. Sono qui con te.";

// ============ SAMPLE ============
const SAMPLES = [
  // ─── A. BREVI CON [pause] ─────────────────────────────────────────
  {
    key: "P1_breve_base",
    label: "P1 — BREVE base (stab 0.55, style 0.35, [pause])",
    text: TEXT_BREVE_PAUSE,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },
  {
    key: "P2_breve_caldo",
    label: "P2 — BREVE caldo (stab 0.45, style 0.50, [pause])",
    text: TEXT_BREVE_PAUSE,
    settings: {
      stability: 0.45,
      style: 0.50,
      similarity_boost: 0.82,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },
  {
    key: "P3_breve_composto",
    label: "P3 — BREVE composto (stab 0.70, style 0.22, [pause])",
    text: TEXT_BREVE_PAUSE,
    settings: {
      stability: 0.70,
      style: 0.22,
      similarity_boost: 0.82,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },

  // ─── B. BREATH NATURALE vs SENZA BREATH ───────────────────────────
  {
    key: "P4_breve_breath_singolo",
    label: "P4 — BREVE con [breath] iniziale singolo (stab 0.55, style 0.35)",
    text: TEXT_BREVE_BREATH,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },
  {
    key: "P5_breve_no_breath",
    label: "P5 — BREVE senza breath, solo ellissi (stab 0.55, style 0.35)",
    text: TEXT_BREVE_NO_BREATH,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },

  // ─── C. ARTICOLATI ────────────────────────────────────────────────
  {
    key: "P6_articolato_base",
    label: "P6 — ARTICOLATO base (stab 0.55, style 0.35, [pause])",
    text: TEXT_ARTICOLATO,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },
  {
    key: "P7_articolato_caldo",
    label: "P7 — ARTICOLATO caldo (stab 0.45, style 0.50, [pause])",
    text: TEXT_ARTICOLATO,
    settings: {
      stability: 0.45,
      style: 0.50,
      similarity_boost: 0.82,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },
  {
    key: "P8_articolato_breath",
    label: "P8 — ARTICOLATO con [breath] iniziale (stab 0.55, style 0.35)",
    text: TEXT_ARTICOLATO_BREATH,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },

  // ─── D. SIMILARITY BOOST ──────────────────────────────────────────
  {
    key: "P9_similarity_alta",
    label: "P9 — BREVE similarity=0.90 (voce Cielo pura, stab 0.55, style 0.35)",
    text: TEXT_BREVE_PAUSE,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.90,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },
  {
    key: "P10_similarity_bassa",
    label: "P10 — BREVE similarity=0.72 (più libera, stab 0.55, style 0.35)",
    text: TEXT_BREVE_PAUSE,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.72,
      speed: SPEED_BASE,
      use_speaker_boost: true,
    },
  },
];

function loadApiKey() {
  const envPath = path.resolve(__dirname, "../../backend/.env");
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$/);
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  throw new Error("ELEVENLABS_API_KEY non trovata in .env");
}

async function generateOne(apiKey, text, voiceSettings) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID_CIELO}?output_format=${OUTPUT_FORMAT}`;
  const body = { text, model_id: MODEL_V3, voice_settings: voiceSettings };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`TTS HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  const apiKey = loadApiKey();
  const outDir = path.resolve(__dirname, "../assets/sounds/paced-tuning");
  const publicDir = path.resolve(__dirname, "../public/paced-tuning");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  console.log(`[paced-tuning] Base speed=${SPEED_BASE}. Genero ${SAMPLES.length} varianti…\n`);

  const manifest = [];
  for (const s of SAMPLES) {
    console.log(`${s.label}`);
    console.log(`  params: ${JSON.stringify(s.settings)}`);
    console.log(`  text:   ${s.text}`);
    try {
      const buf = await generateOne(apiKey, s.text, s.settings);
      const filename = `${s.key}.mp3`;
      const outPath = path.join(outDir, filename);
      fs.writeFileSync(outPath, buf);
      fs.copyFileSync(outPath, path.join(publicDir, filename));
      console.log(`  ✓ ${filename} (${buf.length} bytes)\n`);
      manifest.push({
        key: s.key,
        label: s.label,
        text: s.text,
        settings: s.settings,
        filename,
        bytes: buf.length,
      });
    } catch (e) {
      console.error(`  ✗ FALLITO: ${e.message}\n`);
      manifest.push({ key: s.key, label: s.label, error: e.message });
    }
  }

  fs.writeFileSync(
    path.join(publicDir, "manifest.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), speed_base: SPEED_BASE, samples: manifest }, null, 2),
  );

  console.log(`[paced-tuning] Fatto. Ascoltabili su /paced-tuning/<file>.mp3`);
  console.log(`[paced-tuning] Manifest: /paced-tuning/manifest.json`);
}

main().catch((e) => {
  console.error(`[paced-tuning] FATAL: ${e.message}`);
  process.exit(1);
});
