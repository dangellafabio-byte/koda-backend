/**
 * generate-paced-samples.js
 *
 * One-shot: genera 4 sample audio con lo STESSO testo ma diversi valori
 * di `speed` per farti scegliere il ritmo giusto per il nuovo TONE:paced.
 *
 * Testo usato:
 *   "[softly] Aspetta. [pause] Piano. [pause] Ci sono."
 *
 * Cinque variabili tenute costanti a tutti i sample tranne speed:
 *   stability=0.55, style=0.35, similarity_boost=0.82, use_speaker_boost=true
 * Voice: Cielo (POuqf18evoXOKIqV2Px7)
 * Modello: eleven_v3 (necessario per [softly] e [pause])
 *
 * Sample generati:
 *   sample_paced_speed_072.mp3   (più lento)
 *   sample_paced_speed_076.mp3
 *   sample_paced_speed_080.mp3   (via di mezzo)
 *   sample_paced_speed_084.mp3   (meno lento)
 *
 * Per confronto, includiamo anche un reference:
 *   sample_paced_reference_warm.mp3  (stesso testo, ma con parametri del
 *                                     TONE:warm attuale — speed 0.91, style
 *                                     0.55, stability 0.40)
 *
 * Uso:
 *   node scripts/generate-paced-samples.js
 * Output: /app/frontend/assets/sounds/paced-samples/
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// === Config =========================================================
const VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7";
const MODEL_V3 = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";

// Testo di test: contiene [softly] all'apertura + due [pause] inline.
// Serve a valutare RITMO + PROSODIA + SPAZIO insieme, non solo velocità.
const SAMPLE_TEXT = "[softly] Aspetta. [pause] Piano. [pause] Ci sono.";

// Parametri PACED con speed variabile
const PACED_VARIANTS = [
  { key: "072", speed: 0.72, label: "molto lento" },
  { key: "076", speed: 0.76, label: "lento" },
  { key: "080", speed: 0.80, label: "medio-lento" },
  { key: "084", speed: 0.84, label: "leggermente lento" },
];

const PACED_BASE = {
  stability: 0.55,
  style: 0.35,
  similarity_boost: 0.82,
  use_speaker_boost: true,
};

// Reference: come suonerebbe la STESSA frase in TONE:warm attuale
const WARM_REFERENCE = {
  stability: 0.40,
  style: 0.55,
  similarity_boost: 0.82,
  speed: 0.91,
  use_speaker_boost: true,
};

// === Load API key ====================================================
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

// === TTS single call ==================================================
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

function padSilenceInPlace(mp3Path, leadMs = 200, trailMs = 400) {
  const tmpPath = mp3Path + ".padded.mp3";
  const filter = `adelay=${leadMs}|${leadMs},apad=pad_dur=${(trailMs / 1000).toFixed(3)}`;
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", mp3Path, "-af", filter, "-codec:a", "libmp3lame", "-b:a", "128k", tmpPath],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr || result.stdout || "unknown"}`);
  fs.renameSync(tmpPath, mp3Path);
}

// === Main ============================================================
async function main() {
  const apiKey = loadApiKey();
  const outDir = path.resolve(__dirname, "../assets/sounds/paced-samples");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[paced-samples] Testo: "${SAMPLE_TEXT}"`);
  console.log(`[paced-samples] Voce: Cielo`);
  console.log(`[paced-samples] Modello: ${MODEL_V3}`);
  console.log(``);

  // Genera i 4 sample paced
  for (const variant of PACED_VARIANTS) {
    const settings = { ...PACED_BASE, speed: variant.speed };
    const outPath = path.join(outDir, `sample_paced_speed_${variant.key}.mp3`);
    console.log(`[paced] speed=${variant.speed} (${variant.label})...`);
    const buf = await generateOne(apiKey, SAMPLE_TEXT, settings);
    fs.writeFileSync(outPath, buf);
    // padSilenceInPlace(outPath, 200, 400);  // non essenziale per sample di confronto
    console.log(`   ✓ ${path.basename(outPath)}`);
  }

  // Genera il reference WARM per confronto
  console.log(``);
  console.log(`[reference] TONE:warm attuale (speed=${WARM_REFERENCE.speed})...`);
  const refPath = path.join(outDir, "sample_paced_reference_warm.mp3");
  const refBuf = await generateOne(apiKey, SAMPLE_TEXT, WARM_REFERENCE);
  fs.writeFileSync(refPath, refBuf);
  // padSilenceInPlace(refPath, 200, 400);
  console.log(`   ✓ ${path.basename(refPath)}`);

  console.log(``);
  console.log(`[paced-samples] Fatto. Output: ${outDir}`);
}

main().catch((e) => {
  console.error(`[paced-samples] FATAL: ${e.message}`);
  process.exit(1);
});
