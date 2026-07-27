/**
 * generate-lascia-andare-audio.js
 *
 * One-shot script — genera i 4 file audio per la Stanza dello Sfogo
 * usando ElevenLabs Flash v2.5. Da eseguire UNA SOLA VOLTA in dev.
 *
 * Frasi (fisse, neutre, ripetute per Cielo e Vento):
 *   - Apertura: "Prenditi il tuo tempo."
 *   - Chiusura: "Grazie per averlo lasciato andare."
 *
 * Voice IDs (già usati altrove in KodaIntro.tsx):
 *   - Cielo (femminile): POuqf18evoXOKIqV2Px7
 *   - Vento (maschile):  ll9WG7PDTuyHwgC5MD6g
 *
 * Motivazione: la modalità "Lascia andare" ha vincolo di rete zero
 * durante la sessione utente. Le frasi di presenza devono quindi
 * essere pre-registrate e bundled con l'app. Zero costo variabile
 * ElevenLabs a runtime, latenza zero, funzionamento offline.
 *
 * Costo una tantum: ~4 chiamate × ~35 caratteri × 0.5 crediti = ~70 crediti.
 *
 * Uso:
 *   1. Assicurati che ELEVENLABS_API_KEY sia in /app/backend/.env
 *   2. Da /app/frontend esegui: node scripts/generate-lascia-andare-audio.js
 *   3. I file finiranno in /app/frontend/assets/sounds/lascia-andare/
 */

const fs = require("fs");
const path = require("path");

// === Config =========================================================
const VOICES = {
  cielo: "POuqf18evoXOKIqV2Px7", // Koda Cielo (femminile custom)
  vento: "ll9WG7PDTuyHwgC5MD6g", // Koda Vento (maschile custom)
};

const PHRASES = {
  open: "Prenditi il tuo tempo.",
  close: "Grazie per averlo lasciato andare.",
};

const MODEL_ID = "eleven_flash_v2_5"; // Stesso modello del path conversazionale
const OUTPUT_FORMAT = "mp3_44100_128"; // Coerente con speech.ts (post-fix chipmunk)

// Voice settings coerenti con il default runtime dell'app.
// Stability/similarity tenute vicine ai valori tipici per queste voci.
const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

// === Load API key da /app/backend/.env ===============================
function loadApiKey() {
  const envPath = path.resolve(__dirname, "../../backend/.env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env non trovato: ${envPath}`);
  }
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$/);
    if (m) {
      let v = m[1].trim();
      // Strip quotes se presenti
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  throw new Error("ELEVENLABS_API_KEY non trovata in .env");
}

// === Chiamata TTS =====================================================
async function generateOne(apiKey, voiceId, text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: VOICE_SETTINGS,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 300)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) {
    throw new Error(`Payload troppo corto (${buf.length} bytes) — sospetto errore`);
  }
  return buf;
}

// === Main =============================================================
async function main() {
  console.log("=== Lascia Andare — Audio Generator ===\n");

  const apiKey = loadApiKey();
  const outDir = path.resolve(__dirname, "../assets/sounds/lascia-andare");
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Output dir: ${outDir}\n`);

  const jobs = [
    { key: "open-cielo", voice: VOICES.cielo, text: PHRASES.open },
    { key: "open-vento", voice: VOICES.vento, text: PHRASES.open },
    { key: "close-cielo", voice: VOICES.cielo, text: PHRASES.close },
    { key: "close-vento", voice: VOICES.vento, text: PHRASES.close },
  ];

  let totalBytes = 0;
  for (const job of jobs) {
    const start = Date.now();
    process.stdout.write(
      `[${job.key}] voice=${job.voice.slice(0, 8)}… "${job.text}" `
    );
    try {
      const buf = await generateOne(apiKey, job.voice, job.text);
      const outFile = path.join(outDir, `${job.key}.mp3`);
      fs.writeFileSync(outFile, buf);
      totalBytes += buf.length;
      const ms = Date.now() - start;
      console.log(`→ ${buf.length} bytes in ${ms}ms ✓`);
    } catch (e) {
      console.log(`✗\n  ERRORE: ${e.message}`);
      process.exit(1);
    }
    // Piccola pausa per rispettare rate-limit ElevenLabs
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n✅ Generati 4 file (${(totalBytes / 1024).toFixed(1)} KB totali)`);
  console.log(`   Path: ${outDir}`);
  console.log("\nProssimo passo: bundle con l'app tramite require() nel client.");
}

main().catch((e) => {
  console.error("\n❌ Errore fatale:", e.message);
  process.exit(1);
});
