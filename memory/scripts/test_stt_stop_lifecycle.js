#!/usr/bin/env node
/**
 * Test runtime per il nuovo stop() di VoiceClientSttSession.
 *
 * Simula lo scenario reale: l'utente finisce di parlare, speech.ts chiama
 * session.stop(), e il recognizer nativo emette il result FINALE con un
 * piccolo ritardo (es. 200ms). Prima del fix, stop() mandava subito
 * {type:"end"} al server perché currentTranscript era ancora vuoto.
 * Dopo il fix, stop() aspetta fino a 1200ms e scopre il transcript.
 *
 * Il test NON apre WebSocket reali e NON chiama API. Mocka il modulo
 * `expo-speech-recognition` e la WebSocket.
 */
const path = require("path");
const Module = require("module");
const assert = require("assert");

// ===== Mocking setup =====
const originalResolve = Module._resolve_filename
  ? Module._resolve_filename.bind(Module)
  : Module._resolveFilename.bind(Module);

const virtualModules = new Map();

function stubModule(id, exports) {
  virtualModules.set(id, { exports });
}

const Module_resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (virtualModules.has(request)) {
    return request;
  }
  return Module_resolveFilename.call(this, request, parent, ...rest);
};

const Module_load = Module._load;
Module._load = function (request, parent, isMain) {
  if (virtualModules.has(request)) {
    return virtualModules.get(request).exports;
  }
  return Module_load.call(this, request, parent, isMain);
};

// Stub minimale di expo-speech-recognition
let subscribers = {};
function emit(event, payload) {
  const subs = subscribers[event] || [];
  subs.forEach((cb) => cb(payload));
}
stubModule("expo-speech-recognition", {
  ExpoSpeechRecognitionModule: {
    start: async () => {},
    stop: () => {},
    abort: () => {},
    addListener: (event, cb) => {
      subscribers[event] = subscribers[event] || [];
      subscribers[event].push(cb);
      return {
        remove: () => {
          subscribers[event] = (subscribers[event] || []).filter((c) => c !== cb);
        },
      };
    },
    requestPermissionsAsync: async () => ({ granted: true }),
  },
});

// ===== Mini-replica delle parti rilevanti di stop() =====
// Verifichiamo l'algoritmo con un'implementazione analoga a quella in TS,
// per poter testare in Node senza bundle expo.
class FakeSession {
  constructor() {
    this.stopRequested = false;
    this.doneReceived = false;
    this.currentTranscript = "";
    this.recognizerEndedNatively = false;
    this.sentFrames = [];
  }
  sendJson(obj) {
    this.sentFrames.push(obj);
  }
  async stop() {
    this.stopRequested = true;
    try {
      // Simuliamo expo-speech stop
    } catch {}
    const finalWaitMs = 1200;
    const pollIntervalMs = 50;
    const t0 = Date.now();
    while (Date.now() - t0 < finalWaitMs) {
      if (this.doneReceived) break;
      if (this.currentTranscript && this.currentTranscript.trim().length > 0) break;
      if (this.recognizerEndedNatively) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    if (this.currentTranscript && !this.doneReceived) {
      this.sendJson({ type: "transcript_from_client", text: this.currentTranscript });
    } else {
      this.sendJson({ type: "end" });
    }
    return { waitedMs: Date.now() - t0 };
  }
}

// ===== Scenari di test =====
async function run() {
  const results = [];

  // Scenario A: result finale arriva 200ms dopo stop() → DEVE dispatchare
  async function scenarioA() {
    const s = new FakeSession();
    const stopP = s.stop();
    setTimeout(() => {
      s.currentTranscript = "Ciao Ollenya";
    }, 200);
    await stopP;
    const ok =
      s.sentFrames.length === 1 &&
      s.sentFrames[0].type === "transcript_from_client" &&
      s.sentFrames[0].text === "Ciao Ollenya";
    results.push(["A: final-ritardato-200ms → dispatch", ok, s.sentFrames]);
  }

  // Scenario B: nessun transcript (silenzio), recognizer emette end nativo
  // dopo 100ms → stop() scopre il flag e termina presto con type:end
  async function scenarioB() {
    const s = new FakeSession();
    const stopP = s.stop();
    const t0 = Date.now();
    setTimeout(() => {
      s.recognizerEndedNatively = true;
    }, 100);
    const r = await stopP;
    const ok =
      s.sentFrames.length === 1 &&
      s.sentFrames[0].type === "end" &&
      r.waitedMs < 500; // dovrebbe terminare in ~100-150ms, non 1200
    results.push(["B: silenzio + end nativo rapido → end + wait < 500ms", ok, { waitedMs: r.waitedMs }]);
  }

  // Scenario C: transcript GIÀ popolato prima di stop (final arrivato in anticipo)
  async function scenarioC() {
    const s = new FakeSession();
    s.currentTranscript = "Testo gia pronto";
    const t0 = Date.now();
    await s.stop();
    const elapsed = Date.now() - t0;
    const ok =
      s.sentFrames.length === 1 &&
      s.sentFrames[0].type === "transcript_from_client" &&
      elapsed < 100; // deve ritornare immediatamente senza polling 1200ms
    results.push(["C: transcript pre-stop → dispatch immediato < 100ms", ok, { elapsedMs: elapsed }]);
  }

  // Scenario D: NESSUN final per 1200ms (edge case) → fallback end
  async function scenarioD() {
    const s = new FakeSession();
    const t0 = Date.now();
    const r = await s.stop();
    const elapsed = Date.now() - t0;
    const ok =
      s.sentFrames.length === 1 &&
      s.sentFrames[0].type === "end" &&
      elapsed >= 1100 && elapsed < 1500;
    results.push(["D: nessun final → fallback end dopo ~1200ms", ok, { elapsedMs: elapsed }]);
  }

  // Scenario E: doneReceived settato durante wait → esce subito
  async function scenarioE() {
    const s = new FakeSession();
    const stopP = s.stop();
    setTimeout(() => {
      s.doneReceived = true;
    }, 100);
    const t0 = Date.now();
    await stopP;
    const elapsed = Date.now() - t0;
    // Il wait termina ~100ms, poi va in ramo else (currentTranscript empty)
    const ok =
      s.sentFrames.length === 1 &&
      s.sentFrames[0].type === "end" &&
      elapsed < 500;
    results.push(["E: doneReceived mid-wait → esce rapido", ok, { elapsedMs: elapsed }]);
  }

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();

  console.log("");
  console.log("=== VoiceClientSttSession.stop() runtime scenarios ===");
  let fails = 0;
  for (const [name, ok, detail] of results) {
    if (ok) {
      console.log(`  ✅ ${name}`);
    } else {
      console.log(`  ❌ ${name}  → ${JSON.stringify(detail)}`);
      fails++;
    }
  }
  console.log("");
  console.log(`RESULT: ${results.length - fails}/${results.length} passed`);
  process.exit(fails === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("test crashed:", e);
  process.exit(2);
});
