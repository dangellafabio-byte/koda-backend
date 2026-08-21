/**
 * generate-paced-matrix.js
 *
 * Matrice di 5 sample che esplorano STRATEGIE DIVERSE di creare il
 * cambio di ritmo della presenza, non solo velocità.
 *
 * Ogni sample varia un insieme coordinato di parametri che tentano
 * di produrre "rallentamento del ritmo" attraverso una via diversa:
 *
 *   A — VELOCITÀ: velocità di parlato bassa, prosodia normale
 *       Il rallentamento viene dalla lentezza del parlato in sé.
 *
 *   B — SPAZIO: velocità quasi normale, ma PAUSE lunghe
 *       Il rallentamento viene dal silenzio tra le parole.
 *
 *   C — RESPIRO: velocità media, [breath] al posto di [pause]
 *       Il rallentamento viene dal respiro udibile come punteggiatura.
 *
 *   D — VOCE COMPOSTA: velocità media, stability alta, style basso
 *       Il rallentamento viene da un abbassamento dell'espressività.
 *
 *   E — FRASE ARTICOLATA: velocità media, testo più lungo con
 *       ritmo interno calmo.
 *       Testa se paced funziona anche quando Koda dice più parole.
 *
 * Reference:
 *   • sample_warm_reference.mp3 = TONE:warm attuale (parlata normale)
 *
 * Testo base (A, B, C, D):
 *   "[softly] Aspetta. [pause] Piano. [pause] Ci sono."
 *
 * Testo articolato (E):
 *   "[softly] Aspetta un momento. [pause] Non serve andare veloci
 *    ora. [pause] Sono qui."
 *
 * La domanda percettiva non è "quale è più lento?" ma:
 *   "Quale dà davvero la sensazione che Koda abbia rallentato il
 *    ritmo della conversazione — senza sembrare una voce
 *    artificiosamente rallentata?"
 */

const fs = require("fs");
const path = require("path");

const VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7";
const MODEL_V3 = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";

const TEXT_BASE = "[softly] Aspetta. [pause] Piano. [pause] Ci sono.";
const TEXT_BREATH = "[softly] Aspetta. [breath] Piano. [breath] Ci sono.";
const TEXT_ARTICOLATO =
  "[softly] Aspetta un momento. [pause] Non serve andare veloci ora. [pause] Sono qui.";

const SAMPLES = [
  {
    key: "A_velocita",
    label: "A — FOCUS VELOCITÀ (parlato lento, prosodia normale)",
    text: TEXT_BASE,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: 0.74,
      use_speaker_boost: true,
    },
  },
  {
    key: "B_spazio",
    label: "B — FOCUS SPAZIO (velocità quasi normale, ma pause enfatizzate)",
    text: TEXT_BASE,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: 0.86,
      use_speaker_boost: true,
    },
  },
  {
    key: "C_respiro",
    label: "C — FOCUS RESPIRO ([breath] come punteggiatura vocale)",
    text: TEXT_BREATH,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: 0.80,
      use_speaker_boost: true,
    },
  },
  {
    key: "D_composta",
    label: "D — FOCUS VOCE COMPOSTA (stability alta, style basso, asciutta)",
    text: TEXT_BASE,
    settings: {
      stability: 0.72,
      style: 0.20,
      similarity_boost: 0.82,
      speed: 0.80,
      use_speaker_boost: true,
    },
  },
  {
    key: "E_articolata",
    label: "E — FRASE ARTICOLATA (paced anche con più parole)",
    text: TEXT_ARTICOLATO,
    settings: {
      stability: 0.55,
      style: 0.35,
      similarity_boost: 0.82,
      speed: 0.82,
      use_speaker_boost: true,
    },
  },
];

const WARM_REFERENCE = {
  key: "warm_reference",
  label: "REF — TONE:warm attuale (parlata normale, per confronto)",
  text: TEXT_BASE,
  settings: {
    stability: 0.40,
    style: 0.55,
    similarity_boost: 0.82,
    speed: 0.91,
    use_speaker_boost: true,
  },
};

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
  const outDir = path.resolve(__dirname, "../assets/sounds/paced-matrix");
  const publicDir = path.resolve(__dirname, "../public/paced-matrix");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  const all = [...SAMPLES, WARM_REFERENCE];
  console.log(`[paced-matrix] Generando ${all.length} sample…\n`);

  for (const s of all) {
    console.log(`${s.label}`);
    console.log(`  params: ${JSON.stringify(s.settings)}`);
    console.log(`  text:   ${s.text}`);
    const buf = await generateOne(apiKey, s.text, s.settings);
    const filename = `${s.key}.mp3`;
    const outPath = path.join(outDir, filename);
    fs.writeFileSync(outPath, buf);
    // Copia anche in public/ per essere scaricabile via ingress
    fs.copyFileSync(outPath, path.join(publicDir, filename));
    console.log(`  ✓ ${filename} (${buf.length} bytes)\n`);
  }

  console.log(`[paced-matrix] Fatto. Sample in ${outDir}`);
  console.log(`[paced-matrix] Ascoltabili via preview URL: /paced-matrix/<file>.mp3`);
}

main().catch((e) => {
  console.error(`[paced-matrix] FATAL: ${e.message}`);
  process.exit(1);
});
