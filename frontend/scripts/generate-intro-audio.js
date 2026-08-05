/**
 * generate-intro-audio.js
 *
 * One-shot script — genera i file audio pre-registrati per l'Intro
 * Conversazionale (KodaIntroConversational). Da eseguire UNA VOLTA in dev.
 *
 * Pattern derivato da generate-lascia-andare-audio.js.
 *
 * Perché pre-registrati (non runtime TTS come nel resto dell'app):
 *   • L'Intro è "il primo momento con Koda" — deve suonare identica al
 *     millisecondo per ogni utente. Zero variabilità.
 *   • Zero latenza percepita: audio inizia esattamente al momento del cue.
 *   • Zero costo runtime ricorrente: le stesse 19 clip valgono per ogni
 *     nuovo utente (fino a quando decidiamo di modificarle).
 *   • Funziona anche con rete lenta al primo login.
 *
 * Le frasi che contengono il nome utente (es. "Ciao Marco, piacere di
 * conoscerti") NON sono qui — quelle vanno generate a runtime perché
 * il nome cambia per utente. Le gestisce lasciaAndareVoice-style ma
 * col path TTS classico dell'app (lib/voice.ts o simile).
 *
 * Modello:
 *   • intro_1a (prima presentazione "Sono qui...") → eleven_v3 per la
 *     qualità superiore nel momento più intimo. Coerente col runtime
 *     dell'app dove il chunk 0 usa v3.
 *   • tutte le altre → eleven_flash_v2_5. Coerente col chunk body.
 *
 * Voice IDs:
 *   • Cielo (femminile): POuqf18evoXOKIqV2Px7
 *   • Vento (maschile):  ll9WG7PDTuyHwgC5MD6g
 *
 * Costo one-tantum stimato: ~19 clip × ~40 char media = ~760 char
 *   • Di cui 2 clip su v3 (Sono qui...): ~140 char × 1 credito = 140
 *   • Restanti 17 su flash: ~620 char × 0.5 credito = 310
 *   • TOTALE ≈ 450 crediti ElevenLabs (≈ 0.5€)
 *
 * Uso:
 *   1. Assicurati che ELEVENLABS_API_KEY sia in /app/backend/.env
 *   2. Da /app/frontend esegui: node scripts/generate-intro-audio.js
 *   3. Output in /app/frontend/assets/sounds/intro/
 */

const fs = require("fs");
const path = require("path");

// === Config =========================================================
const VOICES = {
  cielo: "POuqf18evoXOKIqV2Px7",
  vento: "ll9WG7PDTuyHwgC5MD6g",
};

/**
 * Struttura frasi: chiave stabile → { text, voices, useV3 }
 * - voices: ["cielo", "vento"] o solo uno se voice-specific
 * - useV3: true solo per il primissimo audio del flusso (più intimo)
 */
const CLIPS = [
  // Turno 1 — Presentazione (v3 per l'intimità della prima frase)
  { key: "intro_1a", text: "Sono qui. Non ho fretta, non ho bisogno di sapere tutto di te.", voices: ["cielo", "vento"], useV3: true },
  { key: "intro_1b", text: "Solo di riconoscerti quando torni.", voices: ["cielo", "vento"] },

  // Turno 2 — Domanda del nome
  { key: "ask_name", text: "Come ti chiamo?", voices: ["cielo", "vento"] },

  // Turno 3 — Domanda del motivo (dopo il "Ciao [Nome], piacere di conoscerti"
  //           che invece è generato a runtime perché contiene il nome)
  { key: "ask_why", text: "E cosa ti ha portato qui, se ti va di dirmelo?", voices: ["cielo", "vento"] },

  // Turno 4 — Filler neutro dopo la risposta (evita "Ti capisco" che sarebbe
  //           presuntuoso; "Grazie" è caldo e neutrale)
  { key: "filler", text: "Grazie.", voices: ["cielo", "vento"] },

  // Turno 4b — Domanda per secondo sample voiceprint
  { key: "ask_day", text: "Quando torni da me, com'è di solito la tua giornata?", voices: ["cielo", "vento"] },

  // Turno 5 — Terzo sample voiceprint (facoltativo se i primi 2 bastano)
  { key: "ask_moment", text: "Un'ultima domanda: raccontami un momento tuo che ti è rimasto in mente.", voices: ["cielo", "vento"] },

  // Turno 7 — Conferma dopo la scelta voce
  { key: "confirm_choice", text: "Bene. Sarò qui.", voices: ["cielo", "vento"] },

  // Domanda genere (solo se nome ambiguo → deduzione backend fallisce)
  // Solo Cielo perché in quel punto della conversazione è Cielo a parlare.
  { key: "ask_gender", text: "Solo per essere sicura — preferisci che ti dia del lui o del lei?", voices: ["cielo"] },

  // Turno 6 — Vento reveal (colpo di scena, solo voce Vento)
  { key: "vento_reveal_1", text: "Anche io sono Koda.", voices: ["vento"] },
  { key: "vento_reveal_2", text: "Puoi sceglierci.", voices: ["vento"] },
];

const MODEL_V3 = "eleven_v3";
const MODEL_FLASH = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "mp3_44100_128";

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

// === Load API key ====================================================
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

// === TTS single call ==================================================
async function generateOne(apiKey, voiceId, text, useV3) {
  const modelId = useV3 ? MODEL_V3 : MODEL_FLASH;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`;
  const body = {
    text,
    model_id: modelId,
    voice_settings: VOICE_SETTINGS,
  };
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

// === Main ============================================================
async function main() {
  const apiKey = loadApiKey();
  const outDir = path.resolve(__dirname, "../assets/sounds/intro");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`[intro-audio] Created output dir: ${outDir}`);
  }

  // Costruisci la lista completa (key, voice) → path
  const jobs = [];
  for (const clip of CLIPS) {
    for (const voiceKey of clip.voices) {
      jobs.push({
        key: clip.key,
        voiceKey,
        voiceId: VOICES[voiceKey],
        text: clip.text,
        useV3: !!clip.useV3,
        outPath: path.join(outDir, `${clip.key}-${voiceKey}.mp3`),
      });
    }
  }

  console.log(`[intro-audio] Generating ${jobs.length} files…`);
  const startedAt = Date.now();
  let totalBytes = 0;
  let totalChars = 0;
  let charsV3 = 0;
  let charsFlash = 0;

  for (const j of jobs) {
    process.stdout.write(`  → ${path.basename(j.outPath)} (${j.useV3 ? "v3" : "flash"}, ${j.text.length} char)… `);
    try {
      const buf = await generateOne(apiKey, j.voiceId, j.text, j.useV3);
      fs.writeFileSync(j.outPath, buf);
      totalBytes += buf.length;
      totalChars += j.text.length;
      if (j.useV3) charsV3 += j.text.length;
      else charsFlash += j.text.length;
      console.log(`OK (${(buf.length / 1024).toFixed(1)} KB)`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      process.exit(1);
    }
    // Piccolo respiro tra chiamate (ElevenLabs rate limit soft)
    await new Promise((r) => setTimeout(r, 200));
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const creditsV3 = charsV3; // v3 costa 1 credito/char
  const creditsFlash = Math.round(charsFlash * 0.5); // flash costa 0.5 credito/char
  const totalCredits = creditsV3 + creditsFlash;

  console.log(`\n[intro-audio] ═══════════════════════════════════════`);
  console.log(`[intro-audio] Generati ${jobs.length} file in ${elapsed}s`);
  console.log(`[intro-audio] Totale audio: ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log(`[intro-audio] Char totali: ${totalChars} (v3=${charsV3}, flash=${charsFlash})`);
  console.log(`[intro-audio] Crediti stimati: ~${totalCredits} (~${(totalCredits / 1000).toFixed(2)}€)`);
  console.log(`[intro-audio] Output: ${outDir}`);
  console.log(`[intro-audio] ═══════════════════════════════════════`);
}

main().catch((e) => {
  console.error(`[intro-audio] FATAL: ${e.message}`);
  process.exit(1);
});
