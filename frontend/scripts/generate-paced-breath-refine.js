/**
 * generate-paced-breath-refine.js
 *
 * FASE 4 — Rifinitura del respiro.
 *
 * Il carattere della voce è validato (H1/H3): warmth di P2 + similarity 0.90.
 * L'unico problema: il [breath] iniziale è troppo pronunciato/lungo → rischia
 * di far percepire una tecnica applicata da Koda.
 *
 * PARAMETRI FISSI (non toccare):
 *   stability = 0.45
 *   style = 0.50
 *   similarity_boost = 0.90
 *   speed = 0.74
 *
 * Varianti sul solo trattamento del respiro:
 *
 *   H4 — [softly] senza [breath]
 *        Solo morbidezza prosodica in apertura, niente respiro udibile.
 *        Verifica: la warmth prosodica basta a creare presenza senza
 *        bisogno del respiro?
 *
 *   H5 — [breath] spostato all'interno
 *        Respiro come pausa fisica TRA frasi, non come attacco.
 *        Ipotesi: meno "annunciato", più organico.
 *
 *   H6 — [softly] Aspetta. minimale (nessun respiro, pause implicite)
 *        Solo tag [softly] iniziale, niente [pause] esplicite.
 *        Verifica limite: a speed 0.74 la prosodia da sola basta a
 *        creare il ritmo, o le pause esplicite sono necessarie?
 */

const fs = require("fs");
const path = require("path");

const VOICE_ID_CIELO = "POuqf18evoXOKIqV2Px7";
const MODEL_V3 = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";

const BASE_SETTINGS = {
  stability: 0.45,
  style: 0.50,
  similarity_boost: 0.90,
  speed: 0.74,
  use_speaker_boost: true,
};

const SAMPLES = [
  {
    key: "H4_softly_no_breath",
    label: "H4 — [softly] senza [breath]",
    text: "[softly] Aspetta. [pause] Piano. [pause] Ci sono.",
    settings: BASE_SETTINGS,
  },
  {
    key: "H5_breath_interno",
    label: "H5 — [breath] spostato all'interno",
    text: "Aspetta. [breath] Piano. [pause] Ci sono.",
    settings: BASE_SETTINGS,
  },
  {
    key: "H6_softly_minimale",
    label: "H6 — [softly] Aspetta. minimale (no breath, no pause)",
    text: "[softly] Aspetta. Piano. Ci sono.",
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
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
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

  console.log(`[breath-refine] Base: ${JSON.stringify(BASE_SETTINGS)}. Genero ${SAMPLES.length} varianti…\n`);

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
    path.join(publicDir, "manifest-breath-refine.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), base_settings: BASE_SETTINGS, samples: manifest }, null, 2),
  );

  console.log(`[breath-refine] Fatto.`);
}

main().catch((e) => {
  console.error(`[breath-refine] FATAL: ${e.message}`);
  process.exit(1);
});
