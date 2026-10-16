const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('./load-ts.cjs');
const vm = require('node:vm');
const path = require('node:path');

function harness(platform = 'ios') {
  const listeners = new Map();
  const sent = [], errors = [], requests = [], timers = new Map();
  let timerId = 0, nativeStops = 0, nativeStarts = 0;
  const native = {
    requestPermissionsAsync: async () => ({ granted: true }),
    addListener(name, callback) {
      listeners.set(name, callback);
      return { remove() { if (listeners.get(name) === callback) listeners.delete(name); } };
    },
    start() { nativeStarts++; },
    stop() { nativeStops++; },
    abort() {},
  };
  let source = readFileSync(path.join(__dirname, '../lib/voiceClientStt.ts'), 'utf8');
  source = source.replace(/^import[\s\S]*?from ["'][^"']+["'];?/gm, '');
  source = stripTypeScriptTypes(source).replace('export class VoiceClientSttSession', 'class VoiceClientSttSession');
  const audio = { setAudioModeAsync: async () => {}, setIsAudioActiveAsync: async () => {} };
  const context = {
    Platform: { OS: platform }, AppState: {}, ExpoSpeechRecognitionModule: native,
    detectAudioRouteDetailed: async () => ({ route: 'builtin' }),
    kodaBackendWsUrl: () => 'wss://example.test/api/voice/stream', getAuthToken: () => 'test-token',
    console: { log() {}, warn() {} }, require: () => audio,
    fetch: async url => { requests.push(url); return { ok: true }; },
    AbortController, Date, JSON, Math, Promise, ArrayBuffer,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++timerId; }, clearInterval() {},
  };
  vm.runInNewContext(source + '\nglobalThis.Session = VoiceClientSttSession;', context);
  const session = new context.Session({ onError: e => errors.push(e) });
  let opens = 0;
  session.openWs = async () => { opens++; session.ws = { readyState: 1, send: s => sent.push(JSON.parse(s)), close() {} }; };
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { session, native, sent, errors, requests, timers, settle,
    emit: (name, data) => listeners.get(name)?.(data),
    counts: () => ({ nativeStops, nativeStarts, opens }),
    runTimers: delay => { for (const [id, t] of [...timers]) if (t.delay === delay) { timers.delete(id); t.fn(); } },
  };
}

test('stop waits for the native final transcript instead of sending end immediately', async () => {
  const h = harness();
  await h.session.start(); await h.settle();
  await h.session.stop();
  assert.equal(h.sent.filter(m => m.type === 'end').length, 0);
  h.emit('result', { isFinal: true, results: [{ transcript: 'Ciao Ollenya', confidence: 0.9 }] });
  await h.settle();
  assert.equal(h.sent.filter(m => m.type === 'transcript_from_client').length, 1);
  assert.equal(h.sent.find(m => m.type === 'transcript_from_client').text, 'Ciao Ollenya');
  h.emit('end');
  assert.equal(h.sent.filter(m => m.type === 'end').length, 0);
});

test('cleanup of a completed turn cannot stop the recognizer of a later turn', async () => {
  const h = harness(); h.session.doneReceived = true;
  await h.session.stop();
  assert.equal(h.counts().nativeStops, 0);
  assert.equal(h.sent.length, 0);
});

test('abort while permissions are pending prevents later WS and microphone startup', async () => {
  const h = harness(); let resolve;
  h.native.requestPermissionsAsync = () => new Promise(r => { resolve = r; });
  const pending = h.session.start();
  await h.session.abort(); resolve({ granted: true }); await pending; await h.settle();
  assert.equal(h.counts().opens, 0);
  assert.equal(h.counts().nativeStarts, 0);
});

test('warmup uses its own HTTP route even when the WS URL has an auth query', async () => {
  const h = harness(); await h.session.start(); await h.settle();
  assert.equal(h.requests[0], 'https://example.test/api/voice/warmup');
});

test('an empty recognition end reports an error without claiming a successful turn', async () => {
  const h = harness(); await h.session.start(); await h.settle(); h.emit('end');
  assert.ok(h.errors.includes('client_stt_end_without_transcript'));
  assert.equal(h.sent.filter(m => m.type === 'transcript_from_client').length, 0);
});

test('Android also keeps the socket open for the asynchronous final result', async () => {
  const h = harness('android');
  const pending = h.session.start();
  await h.settle(); h.runTimers(100); await h.settle();
  await pending; h.runTimers(80); await h.settle();
  assert.equal(h.counts().nativeStarts, 1);
  await h.session.stop();
  assert.equal(h.sent.filter(m => m.type === 'end').length, 0);
  h.emit('result', { isFinal: true, results: [{ transcript: 'Ciao dal tablet', confidence: 0.9 }] });
  await h.settle();
  assert.equal(h.sent.filter(m => m.type === 'transcript_from_client').length, 1);
});

test('a stop without any native result times out explicitly and sends no invented transcript', async () => {
  const h = harness(); await h.session.start(); await h.settle();
  await h.session.stop(); h.runTimers(1500);
  assert.ok(h.errors.includes('client_stt_end_without_transcript'));
  assert.equal(h.sent.filter(m => m.type === 'transcript_from_client').length, 0);
});
