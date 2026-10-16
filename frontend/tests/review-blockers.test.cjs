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


test('completed session cleanup must not stop a later recognizer', async () => {
  const h = harness(); h.session.doneReceived = true;
  await h.session.stop();
  assert.equal(h.counts().nativeStops, 0, 'cleanup still calls global native stop');
  assert.equal(h.sent.length, 0, 'completed session still sends end');
});

test('a natural final must release an Android continuous recognizer', async () => {
  const h = harness('android');
  const pending = h.session.start();
  await h.settle(); h.runTimers(100); await h.settle();
  await pending; h.runTimers(80); await h.settle();
  assert.equal(h.counts().nativeStarts, 1);
  h.emit('result', { isFinal: true, results: [{ transcript: 'Ciao dal tablet', confidence: 0.9 }] });
  await h.settle();
  assert.equal(h.sent.filter(m => m.type === 'transcript_from_client').length, 1);
  assert.equal(h.counts().nativeStops, 1, 'final dispatch removed all native stop calls while continuous recognition can still be active');
});

test('an interim result is not sent as final before native stop delivers its final result', async () => {
  const h = harness(); await h.session.start(); await h.settle();
  h.emit('result', { isFinal: false, results: [{ transcript: 'Voglio', confidence: 0.7 }] });
  const pending = h.session.stop();
  assert.equal(h.sent.filter(m => m.type === 'transcript_from_client').length, 0);
  h.emit('result', { isFinal: true, results: [{ transcript: 'Voglio parlare con te', confidence: 0.9 }] });
  await pending; await h.settle();
  assert.equal(h.sent.find(m => m.type === 'transcript_from_client').text, 'Voglio parlare con te');
});
