// T1 probe (iteration 10): realistic Android native event sequences vs v70.6.1 user spec.
// Runs the REAL lib/voiceClientStt.ts + lib/androidUtterance.ts with a fake clock.
// Prints PASS/FAIL per scenario; exit code 1 if any spec assertion fails. No skips.
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
  async function start() {const p = session.startRecognition('it'); tick(80); await p;}
  async function drive(ms) {for (let i = 0; i < ms / 50; i++) {tick(50); await new Promise(r => setImmediate(r));}}
  return {session, calls, tick, emit, result, start, drive, now: () => now};
}

const results = [];
function check(name, ok, detail) {results.push({name, ok}); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);}

(async () => {
  // P1 late final after stop(): what text is dispatched? (no duplication, full sentence)
  let h = harness(); h.session.autoEndpoint = false; await h.start(); h.emit('start');
  h.result('Ciao Ollenya', true); h.result('come stai');
  let p = h.session.stop(); await new Promise(r => setImmediate(r));
  h.result('come stai', true); await h.drive(2000); await p;
  check('P1 late final merges committed+final once', JSON.stringify(h.calls.dispatch) === JSON.stringify(['Ciao Ollenya come stai']), JSON.stringify(h.calls.dispatch));

  // P2 committed + pending partial, NO native final within grace -> tail lost?
  h = harness(); h.session.autoEndpoint = false; await h.start(); h.emit('start');
  h.result('Prendi il latte', true); h.result('e anche il pane');
  const t0 = h.now(); p = h.session.stop(); await h.drive(2000); await p;
  check('P2 stop() waited >=1500ms grace before deciding', h.now() - t0 >= 1500, `elapsed=${h.now() - t0}`);
  check('P2 committed+partial w/o native final keeps tail', JSON.stringify(h.calls.dispatch) === JSON.stringify(['Prendi il latte e anche il pane']), `dispatched=${JSON.stringify(h.calls.dispatch)} (spec: safeText-only insufficient)`);

  // P3 PTT held ~20s with NO speech, realistic Android: recognizer emits error no-speech + end
  h = harness(); h.session.autoEndpoint = false; await h.start(); h.emit('start');
  h.tick(8000); h.emit('error', {error: 'no-speech', message: ''}); h.emit('end'); h.tick(12000);
  check('P3 PTT held 20s, native no-speech+end does NOT terminate turn while finger held', h.calls.errors.length === 0 && h.calls.starts.length > 1,
    `errors=${JSON.stringify(h.calls.errors)} nativeStarts=${h.calls.starts.length} (no auto-restart of native recognizer while held)`);

  // P4 PTT held: speech, then 5s pause (mid-silence tolerance), native end, user keeps holding
  h = harness(); h.session.autoEndpoint = false; await h.start(); h.emit('start');
  h.emit('speechstart'); h.result('Allora', true); h.tick(5000); h.emit('end'); h.tick(3000);
  check('P4 PTT mid-silence: native end while held does not dispatch before release', h.calls.dispatch.length === 0,
    `dispatched=${JSON.stringify(h.calls.dispatch)} errors=${JSON.stringify(h.calls.errors)}`);

  // P5 PTT held, speechstart noise with no transcript for 20s -> no stall error
  h = harness(); h.session.autoEndpoint = false; await h.start(); h.emit('start');
  for (let i = 0; i < 10; i++) {h.emit('speechstart'); h.tick(2000);}
  check('P5 PTT 20s noise/no text: no android_transcript_stalled', h.calls.errors.length === 0, JSON.stringify(h.calls.errors));

  // P6 HF: native no-match -> onError('nomatch')
  h = harness(); await h.start(); h.emit('start'); h.emit('error', {error: 'no-match', message: ''});
  check('P6 native no-match surfaces as nomatch', JSON.stringify(h.calls.errors) === JSON.stringify(['nomatch']), JSON.stringify(h.calls.errors));

  // P7 HF: native no-speech + end -> no_speech (benign, not ended_early)
  h = harness(); await h.start(); h.emit('start'); h.tick(5000); h.emit('error', {error: 'no-speech'}); h.emit('end');
  check('P7 HF no-speech -> no_speech code', JSON.stringify(h.calls.errors) === JSON.stringify(['no_speech']), JSON.stringify(h.calls.errors));

  // P8 PTT: stop() during partial, native end (no final) during grace -> what is dispatched
  h = harness(); h.session.autoEndpoint = false; await h.start(); h.emit('start');
  h.result('Vorrei sapere');
  p = h.session.stop(); await new Promise(r => setImmediate(r)); h.emit('end'); await h.drive(2000); await p;
  check('P8 stop()+native end without final during grace: consistent with partial-only rule (nomatch, no dispatch)',
    h.calls.dispatch.length === 0 && h.calls.errors.includes('nomatch'),
    `dispatched=${JSON.stringify(h.calls.dispatch)} errors=${JSON.stringify(h.calls.errors)}`);

  // P9 Known expo-speech-recognition Android continuous race (jamsch/expo-speech-recognition#158):
  // native stop() right after speech -> ERROR_CLIENT ("client") instead of final for the open segment.
  h = harness(); h.session.autoEndpoint = false; await h.start(); h.emit('start');
  h.result('Ricordami domani', true); h.result('alle nove');
  p = h.session.stop(); await new Promise(r => setImmediate(r));
  h.emit('error', {error: 'client', message: 'Client side error'}); h.emit('end'); await h.drive(2000); await p;
  check('P9 stop() + native "client" error during grace still dispatches committed text (no error banner)',
    h.calls.dispatch.length === 1 && !h.calls.errors.some(e => e.startsWith('client_stt_')),
    `dispatched=${JSON.stringify(h.calls.dispatch)} errors=${JSON.stringify(h.calls.errors)}`);

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} spec probes passed`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => {console.error('PROBE CRASH', e); process.exitCode = 2;});
