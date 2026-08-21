/**
 * generate-paced-hybrid.js
 *
 * FASE 3 — Ibridi P2 × P4.
 *
 * L'utente ha selezionato "P2 e P4 insieme":
 *   • P2 → breve caldo (stability 0.45, style 0.50, [pause])
 *   • P4 → breve con [breath] iniziale singolo (stability 0.55, style 0.35)
 *
 * Interpretazione: prendere la WARMTH prosodica di P2 e applicarla alla
 * struttura di apertura di P4 (respiro udibile che precede la parola).
 *
 * Base FISSA:
 *   speed = 0.74
 *   stability = 0.45
 *   style = 0.50
 *   similarity_boost = 0.82
 *
 * Varianti:
 *
 *   H1 — SHORT · [breath] puro + [pause]
 *        Il respiro apre. Niente [softly]: verifichiamo se il calore
 *        arriva già dai settings prosodici senza bisogno del tag.
 *
 *   H2 — SHORT · [softly] + [breath] + [pause]
 *        Combo massima. Verifica se [softly] e [breath] si sommano
 *        o si "mangiano" a vicenda.
 *
 *   H3 — ARTICOLATO · [breath] + [pause]
 *        Il vincitore ipotetico su una risposta più lunga:
 *        paced non deve costringere Koda a essere breve.
 */

const fs = require("fs");
const path = require("path");

const VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7";
const MODEL_V3 = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";

const BASE_SETTINGS = {
  stability: 0.45,        // ← da P2 (warmth espressiva)
  style: 0.50,            // ← da P2 (calore prosodico)
  similarity_boost: 0.90, // ← da P9 (voce più riconoscibilmente Koda)
  speed: 0.74,            // ← baseline "molto lento" scelta dall'utente
  use_speaker_boost: true,
};

const SAMPLES = [
  {
    key: "H1_short_breath",
    label: "H1 — SHORT · [breath] puro",
    text: "[breath] Aspetta. [pause] Piano. [pause] Ci sono.",
    settings: BASE_SETTINGS,
  },
  {
    key: "H2_short_softly_breath",
    label: "H2 — SHORT · [softly] + [breath]",
    text: "[softly] [breath] Aspetta. [pause] Piano. [pause] Ci sono.",
    settings: BASE_SETTINGS,
  },
  {
    key: "H3_articolato_breath",
    label: "H3 — ARTICOLATO · [breath] iniziale",
    text: "[breath] Aspetta un momento. [pause] Non serve andare veloci ora. [pause] Sono qui con te.",
    settings: BASE_SETTINGS,
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
  const publicDir = path.resolve(__dirname, "../public/paced-tuning");
  fs.mkdirSync(publicDir, { recursive: true });

  console.log(`[hybrid] Base: ${JSON.stringify(BASE_SETTINGS)}. Genero ${SAMPLES.length} ibridi…\n`);

  const manifest = [];
  for (const s of SAMPLES) {
    console.log(s.label);
    console.log(`  text: ${s.text}`);
    try {
      const buf = await generateOne(apiKey, s.text, s.settings);
      const filename = `${s.key}.mp3`;
      fs.writeFileSync(path.join(publicDir, filename), buf);
      console.log(`  ✓ ${filename} (${buf.length} bytes)\n`);
      manifest.push({ key: s.key, label: s.label, text: s.text, settings: s.settings, filename, bytes: buf.length });
    } catch (e) {
      console.error(`  ✗ FALLITO: ${e.message}\n`);
      manifest.push({ key: s.key, label: s.label, error: e.message });
    }
  }

  fs.writeFileSync(
    path.join(publicDir, "manifest-hybrid.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), base_settings: BASE_SETTINGS, samples: manifest }, null, 2),
  );

  console.log(`[hybrid] Fatto. Manifest: /paced-tuning/manifest-hybrid.json`);
}

main().catch((e) => {
  console.error(`[hybrid] FATAL: ${e.message}`);
  process.exit(1);
});
