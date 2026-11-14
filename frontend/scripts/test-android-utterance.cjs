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

  // === v70.6 (2026-11-14) — test riabilitato =============================
  // v70.5.4 aveva disattivato AndroidUtterance temporaneamente. Il test
  // chirurgico ha dimostrato che era la direzione sbagliata: il PTT risultava
  // rotto. v70.6 ripristina continuous=true + AndroidUtterance e questo
  // test certifica il comportamento della pipeline accumulator.
  let h = harness();await h.start();

  assert.equal(h.calls.starts[0].continuous, true);
  assert.equal(h.calls.ready, 0, 'start invocation does not prove readiness');
  h.emit('start');assert.equal(h.calls.ready, 1);
  h.tick(6000);assert.equal(h.calls.errors.length, 0, 'ready but quiet is not a dead mic');
  // Con AndroidUtterance ON (continuous=true) e autoEndpoint default=true,
  // un final NON scatena dispatch immediato: aspetta quietMs (3000ms).
  h.emit('speechstart');
  h.result('Perché lei cambia le impostazioni e non riesco a finire', true);
  assert.equal(h.calls.dispatch.length, 0, 'final non deve dispatch immediatamente');
  h.tick(2999);
  assert.equal(h.calls.dispatch.length, 0, 'quietMs non ancora scaduto');
  h.tick(1);
  assert.deepEqual(h.calls.dispatch, ['Perché lei cambia le impostazioni e non riesco a finire']);
  h.tick(10000);assert.equal(h.calls.dispatch.length, 1, 'tick extra non duplicano dispatch');


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


  h = harness();await h.start();h.emit('start');
  for (let i = 0; i < 6; i++) {h.emit('speechstart');h.tick(2000);}
  assert.deepEqual(h.calls.errors, ['android_transcript_stalled'], 'sound without transcription cannot keep recording forever');
  assert.equal(h.calls.dispatch.length, 0);


  // v70.6.1 user spec: in PTT (autoEndpoint=false), partial-only + release
  // NON deve dispatch (si rischia di perdere coda). Attende 1500ms per un
  // native final, se non arriva → nomatch (chiedi ripeti).
  h = harness();h.session.autoEndpoint = false;await h.start();h.emit('start');
  h.result('Una frase detta piano');h.tick(6000);
  assert.equal(h.calls.dispatch.length, 0, 'PTT must wait for release, not an automatic endpoint');

  // v70.6.1 user spec requirement — "PTT mantenuto senza testo per oltre
  // 10 secondi: nessun arresto automatico per silenzio". In autoEndpoint=false
  // il progress timer (10s initial) NON deve armarsi. Simula 20s senza
  // risultato: nessun dispatch, nessun errore stall.
  const hPtt20s = harness();hPtt20s.session.autoEndpoint = false;await hPtt20s.start();
  hPtt20s.emit('start');
  hPtt20s.tick(20000);
  assert.equal(hPtt20s.calls.errors.length, 0, 'PTT held 20s senza testo: nessun stall');
  assert.equal(hPtt20s.calls.dispatch.length, 0, 'PTT held 20s senza testo: nessun dispatch');
  // Launch stop() non-blocking, then advance fake clock through grace window.
  const stopPromise = h.session.stop();
  // Simulate grace: advance 1500ms of fake clock to exhaust pending-partial wait.
  for (let i = 0; i < 40; i++) { h.tick(50); await new Promise(r => setImmediate(r)); }
  await stopPromise;

  assert.equal(h.calls.dispatch.length, 0, 'PTT release with only partial does NOT dispatch');
  assert.ok(h.calls.errors.includes('nomatch'), 'PTT release with only partial fires nomatch (ask-to-repeat)');


  // v70.6.1 new test: committed + new partial + stop → grace wait → native
  // final arrives → full dispatch (no coda lost).
  h = harness();h.session.autoEndpoint = false;await h.start();h.emit('start');
  h.result('Ciao Ollenya', true); // committed final
  h.result('come stai'); // new partial started
  const stopPromise2 = h.session.stop();
  // During grace, simulate Google emitting the late final:
  await new Promise(r => setImmediate(r));
  h.result('Ciao Ollenya come stai?', true);
  for (let i = 0; i < 40; i++) { h.tick(50); await new Promise(r => setImmediate(r)); }
  await stopPromise2;

  assert.ok(h.calls.dispatch.length >= 1, 'late final after stop() must be dispatched');


  h = harness();await h.start();h.emit('start');h.result('Risultato');
  h.tick(2000);h.result('Risultato');h.tick(1000);
  assert.deepEqual(h.calls.dispatch, ['Risultato'], 'unchanged interim events must not extend the endpoint');

  h = harness('ios');await h.start();h.result('Frase completa', true);
  assert.deepEqual(h.calls.dispatch, ['Frase completa'], 'iOS final path remains immediate');
  assert.equal(h.calls.starts[0].continuous, false);

  // Execute the actual UI error branch, checking that one native failure
  // pauses hands-free immediately; ordinary network backoff is preserved.
  const screen = fs.readFileSync(path.join(__dirname, '../app/index.tsx'), 'utf8');
  const start = screen.indexOf('          const recognitionInterrupted = ');
  const end = screen.indexOf('\n        }\n      } else {\n        // Successo', start);
  for (const error of ['android_recognition_ended_early', 'android_no_speech', 'android_transcript_stalled', 'client_stt_audio-capture']) {
    const ctx = {Platform: {OS: 'android'}, result: {error}, failN: 1, WS_FAIL_THRESHOLD: 3,
      console: {log() {}}, setCloseSessionPause() {}, closeSessionPauseRef: {current: false},
      setError() {}, setTimeout() {}};
    vm.createContext(ctx);vm.runInContext(screen.slice(start, end), ctx);
    assert.equal(ctx.closeSessionPauseRef.current, true, error + ' must stop automatic re-entry');
  }

  // Execute the actual screen stopTalk handler: streaming has no recRef.
  const ast = ts.createSourceFile('index.tsx', screen, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let stopDeclaration;
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'stopTalk') stopDeclaration = node;
    ts.forEachChild(node, find);
  }
  find(ast);assert(stopDeclaration);
  const stopJs = ts.transpileModule('const ' + stopDeclaration.getText(ast) + '; exports.stop = stopTalk;',
    {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  let stops = 0;
  const stopCtx = {exports: {}, streamingSessionRef: {current: {stop: async () => {stops++;}}},
    recRef: {current: null}, pendingTapStopRef: {current: false},
    releaseIntentRef: {current: false}, statusRef: {current: 'recording'},
    setStatus() {}, console: {log() {}}, Promise};
  vm.createContext(stopCtx);vm.runInContext(stopJs, stopCtx);
  await stopCtx.exports.stop();assert.equal(stops, 1, 'PTT release must call the live streaming session stop');
  stopCtx.streamingSessionRef.current = null;
  // v70.6: scenario "release durante preparazione async" (no stream, no recRef,
  // status=idle, ma releaseIntentRef=true impostato da onPressOut PRIMA degli await).
  // Deve queuettare pendingTapStopRef, non ritornare silenziosamente.
  stopCtx.releaseIntentRef.current = true; stopCtx.statusRef.current = 'idle';
  await stopCtx.exports.stop();
  assert.equal(stopCtx.pendingTapStopRef.current, true, 'release durante preparazione async è ritenuto grazie a releaseIntentRef');
  console.log('PASS: actual native session handlers, segmented speech, pause, readiness, cancellation, early end, release-race, iOS');
})().then(() => process.exit(0)).catch(e => {console.error('FAIL:', e.message || e, e.stack);process.exit(1);});
