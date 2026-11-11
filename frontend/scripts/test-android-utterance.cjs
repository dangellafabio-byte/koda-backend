const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

function harness(os = 'android') {
  let now = 100000, next = 0;
  const timers = new Map(), listeners = new Map(), calls = {dispatch: [], errors: [], ready: 0, starts: []};
  const clock = {
    Date: class extends Date {static now() {return now;}},
    setTimeout(fn, ms) {const id = ++next; timers.set(id, {fn, at: now + ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
  };
  const native = {
    abort() {}, stop() {}, start(options) {calls.starts.push(options);},
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
    const ctx = {exports: {}, require: name => load(name.replace(/^\.\//, '')),
      console: {log() {}, warn() {}, error() {}}, ...clock, setInterval() {}, clearInterval() {},
      Promise, Uint8Array, ArrayBuffer};
    vm.createContext(ctx);vm.runInContext(compiled.outputText, ctx);
    exportsByFile.set(name, ctx.exports);return ctx.exports;
  }
  const Ctor = load('voiceClientStt').VoiceClientSttSession;
  const session = new Ctor({onRecognitionActive: () => calls.ready++, onError: e => calls.errors.push(e)});
  session.forceCloseWs = () => {};
  session.dispatchFinalToBackend = async () => {
    if (session.dispatched || session.doneReceived) return;
    calls.dispatch.push(session.currentTranscript);
    session.dispatched = true;
    session.removeListeners();
  };
  function tick(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([,t]) => t.at <= until).sort((a,b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;timers.delete(due[0]);due[1].fn();
    }
    now = until;
  }
  function emit(name, evt) {for (const fn of [...(listeners.get(name) || [])]) fn(evt);}
  function result(text, final = false) {emit('result', {isFinal: final, results: [{transcript: text, confidence: .9}]});}
  async function start() {const promise = session.startRecognition('it');tick(80);await promise;}
  return {session, calls, tick, emit, result, start};
}

(async () => {
  let h = harness();await h.start();
  assert.equal(h.calls.starts[0].continuous, true);
  assert.equal(h.calls.ready, 0, 'start invocation does not prove readiness');
  h.emit('start');assert.equal(h.calls.ready, 1);
  h.tick(6000);assert.equal(h.calls.errors.length, 0, 'ready but quiet is not a dead mic');
  h.emit('speechstart');h.result('Perché lei cambia');h.tick(2000);
  h.result('Perché lei cambia le impostazioni', true);
  assert.equal(h.calls.dispatch.length, 0, 'final segment must not end a turn');
  h.tick(2000);h.result('e non riesco');h.tick(2000);
  h.result('e non riesco a finire', true);h.tick(2999);
  assert.equal(h.calls.dispatch.length, 0);
  h.tick(1);assert.deepEqual(h.calls.dispatch, ['Perché lei cambia le impostazioni e non riesco a finire']);
  h.tick(10000);assert.equal(h.calls.dispatch.length, 1);

  h = harness();await h.start();h.emit('start');h.result('Sto ancora parlando');h.tick(100);
  h.emit('end');h.tick(6000);
  assert.equal(h.calls.dispatch.length, 0, 'unexpected early end must not send a partial');
  assert.deepEqual(h.calls.errors, ['android_recognition_ended_early']);

  h = harness();const startup = h.session.startRecognition('it');
  h.session.stopRequested = true;h.tick(80);await startup;
  assert.equal(h.calls.starts.length, 0, 'stop during pre-abort delay cannot start a mic later');

  h = harness();await h.start();h.emit('start');h.result('Primo segmento', true);
  h.result('Primo segmento', true);h.tick(3000);
  assert.deepEqual(h.calls.dispatch, ['Primo segmento'], 'duplicate final is not duplicated text');

  h = harness();await h.start();h.result('Frase');h.session.removeListeners();h.tick(6000);
  assert.equal(h.calls.dispatch.length, 0, 'teardown cancels deferred dispatch');

  h = harness('ios');await h.start();h.result('Frase completa', true);
  assert.deepEqual(h.calls.dispatch, ['Frase completa'], 'iOS final path remains immediate');
  assert.equal(h.calls.starts[0].continuous, false);

  // Execute the actual UI error branch, checking that one native failure
  // pauses hands-free immediately; ordinary network backoff is preserved.
  const screen = fs.readFileSync(path.join(__dirname, '../app/index.tsx'), 'utf8');
  const start = screen.indexOf('        const recognitionInterrupted = ');
  const end = screen.indexOf('\n      } else {\n        // Successo', start);
  for (const error of ['android_recognition_ended_early', 'android_no_speech', 'client_stt_audio-capture']) {
    const ctx = {Platform: {OS: 'android'}, result: {error}, failN: 1, WS_FAIL_THRESHOLD: 3,
      console: {log() {}}, setCloseSessionPause() {}, closeSessionPauseRef: {current: false},
      setError() {}, setTimeout() {}};
    vm.createContext(ctx);vm.runInContext(screen.slice(start, end), ctx);
    assert.equal(ctx.closeSessionPauseRef.current, true, error + ' must stop automatic re-entry');
  }
  console.log('PASS: actual native session handlers, segmented speech, pause, readiness, cancellation, early end and iOS');
})().catch(e => {console.error(e);process.exitCode=1;});
