/**
 * generate-paced-h4-articolato.js
 *
 * FASE 5 — Sanity check finale.
 *
 * L'utente ha scelto H4 come pattern definitivo per paced:
 *   - Parametri: stability 0.45, style 0.50, similarity 0.90, speed 0.74
 *   - Tag policy: [softly] iniziale + [pause] tra frasi (NO [breath])
 *
 * Vincolo architetturale: paced NON obbliga Koda a essere breve.
 * Deve reggere anche risposte articolate. Rigenero H3 con il pattern H4
 * (senza [breath]) per verifica finale prima del lock in server.py.
 */

const fs = require("fs");
const path = require("path");

const VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7";
const MODEL_V3 = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";

const SETTINGS = {
  stability: 0.45,
  style: 0.50,
  similarity_boost: 0.90,
  speed: 0.74,
  use_speaker_boost: true,
};

// Articolato con SOLO [softly] iniziale + [pause] tra frasi (pattern H4).
const TEXT = "[softly] Aspetta un momento. [pause] Non serve andare veloci ora. [pause] Sono qui con te.";

function loadApiKey() {
  const envPath = path.resolve(__dirname, "../../backend/.env");
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$/);
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
  throw new Error("ELEVENLABS_API_KEY non trovata in .env");
}

async function generateOne(apiKey, text, voiceSettings) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID_CIELO}?output_format=${OUTPUT_FORMAT}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: MODEL_V3, voice_settings: voiceSettings }),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const apiKey = loadApiKey();
  const publicDir = path.resolve(__dirname, "../public/paced-tuning");
  fs.mkdirSync(publicDir, { recursive: true });

  console.log(`[H4-articolato] Params: ${JSON.stringify(SETTINGS)}`);
  console.log(`[H4-articolato] Text: ${TEXT}\n`);

  const buf = await generateOne(apiKey, TEXT, SETTINGS);
  const filename = "H4_articolato.mp3";
  fs.writeFileSync(path.join(publicDir, filename), buf);
  console.log(`✓ ${filename} (${buf.length} bytes)`);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
