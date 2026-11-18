const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness(os = 'android') {
  let now = 100000, next = 0;
  const timers = new Map(), listeners = new Map(), calls = {dispatch: [], errors: [], ready: 0, starts: [], stops: 0};
  const clock = {
    Date: class extends Date {static now() {return now;}},
    setTimeout(fn, ms) {const id = ++next; timers.set(id, {fn, at: now + (ms || 0)}); return id;},
    clearTimeout(id) {timers.delete(id);},
  };
  const native = {
    abort() {}, stop() {calls.stops++;}, start(options) {calls.starts.push(options);},
    addListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return {remove() {listeners.get(name).delete(fn);}};
    },
  };
  const exportsByFile = new Map();
  function load(name) {
    if (name === 'react-native') return {Platform: {OS: os}, AppState: {currentState: 'active'}};
    if (name === 'expo-speech-recognition') return {ExpoSpeechRecognitionModule: native};
    if (!['voiceClientStt', 'androidUtterance'].includes(name)) return {};
    if (exportsByFile.has(name)) return exportsByFile.get(name);
    const source = fs.readFileSync(path.join(__dirname, '../lib', name + '.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}});
    const ctx = {exports: {}, require: n => load(n.replace(/^\.\//, '')),
      console: {log() {}, warn() {}, error() {}}, ...clock, setInterval() {}, clearInterval() {},
      Promise, Uint8Array, ArrayBuffer};
    vm.createContext(ctx); vm.runInContext(compiled.outputText, ctx);
    exportsByFile.set(name, ctx.exports); return ctx.exports;
  }
  const Ctor = load('voiceClientStt').VoiceClientSttSession;
  const session = new Ctor({onRecognitionActive: () => calls.ready++, onError: e => calls.errors.push(e)});
  session.forceCloseWs = () => {};
  session.sendJson = () => {};
  session.dispatchFinalToBackend = async () => {
    if (session.dispatched || session.doneReceived) return;
    calls.dispatch.push(session.currentTranscript);
    session.dispatched = true;
    session.removeListeners();
  };
  function tick(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = until;
  }
  const emit = (name, evt) => {for (const fn of [...(listeners.get(name) || [])]) fn(evt);};
  const result = (text, final = false) => emit('result', {isFinal: final, results: [{transcript: text, confidence: .9}]});
  async function start() {const p = session.startRecognition('it'); tick(220); await p;}
  async function drive(ms) {for (let i = 0; i < ms / 50; i++) {tick(50); await new Promise(r => setImmediate(r));}}
  return {session, calls, tick, emit, result, start, drive, now: () => now};
}


const assert = require('node:assert/strict');

(async () => {
  const h = harness('ios');
  h.session.autoEndpoint = false;
  await h.start();
  h.emit('start');
  assert.equal(h.calls.starts[0].continuous, true);
  h.result('Ricordami domani', true);
  h.result(' alle');
  assert.deepEqual(h.calls.dispatch, []);
  const first = h.session.stop();
  const duplicate = h.session.stop();
  h.emit('end');
  assert.deepEqual(h.calls.dispatch, []);
  h.result(' alle nove', true);
  await Promise.all([first, duplicate]);
  assert.deepEqual(h.calls.dispatch, ['Ricordami domani alle nove']);
  assert.equal(h.calls.stops, 1);

  const handFree = harness('ios');
  await handFree.start();
  assert.equal(handFree.calls.starts[0].continuous, false);
  handFree.emit('error', {error: 'no-match'});
  handFree.emit('end');
  assert.deepEqual(handFree.calls.errors, ['speech_not_recognized']);

  const silent = harness('ios');
  await silent.start();
  silent.emit('error', {error: 'no-speech'});
  silent.emit('end');
  assert.deepEqual(silent.calls.errors, ['no_speech']);

  const incomplete = harness('ios');
  incomplete.session.autoEndpoint = false;
  await incomplete.start();
  incomplete.result('Frase incompleta');
  const pending = incomplete.session.stop();
  await incomplete.drive(1550);
  await pending;
  assert.deepEqual(incomplete.calls.dispatch, []);
  assert.deepEqual(incomplete.calls.errors, ['speech_not_recognized']);
  console.log('PASS iOS: hold, late final after end, duplicate release, no-match, silence and incomplete speech');
})().catch(error => { console.error(error); process.exitCode = 1; });
