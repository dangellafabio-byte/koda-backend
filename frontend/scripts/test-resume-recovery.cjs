// Execute the actual lifecycle recovery branch with mocked native surfaces.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/index.tsx'), 'utf8');
const start = source.indexOf('// Only a real background transition counts:');
const end = source.indexOf('// === FIX 2026-06-28 v32', start);
const branch = source.slice(start, end).replace(' as any', '');
assert(start > 0 && end > start);

function setup({status = 'thinking', timeline = [], deferred = null} = {}) {
  const calls = {aborts: 0, stops: 0, timelines: [], errors: []};
  const ctx = {
    console: {log() {}, warn() {}}, Promise, Date,
    setTimeout: (fn) => { queueMicrotask(fn); },
    wasActuallyBackgroundedRef: {current: false}, statusRef: {current: status},
    voiceTurnEpochRef: {current: 1}, voiceTurnStartedAtRef: {current: 1000},
    streamingSessionRef: {current: {abort: async () => { calls.aborts++; }}},
    userInteractedRef: {current: true}, convActiveRef: {current: true},
    closeSessionPauseRef: {current: false}, micReallyActiveRef: {current: true},
    pendingTapStopRef: {current: true}, setConvActive() {}, setCloseSessionPause() {},
    SpeechMod: {stop() {calls.stops++;}}, stopThinkingSound() {},
    setStatus: (s) => {ctx.statusRef.current = s;},
    setError: (s) => calls.errors.push(s),
    setTimeline: (tl) => calls.timelines.push(tl),
    api: {getTimeline: async () => deferred ? await deferred : timeline},
  };
  vm.createContext(ctx);
  const event = vm.runInContext(`(next) => { ${branch} }`, ctx);
  return {ctx, calls, event};
}
const flush = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
(async () => {
  let t = setup();
  t.event('inactive'); t.event('active');
  assert.equal(t.calls.aborts, 0, 'privacy flicker must not cancel a turn');
  t = setup({status: 'recording'});
  t.event('background'); t.event('active');
  assert.equal(t.calls.aborts, 0, 'recording guard remains intact');
  const reply = [{role: 'ai', timestamp: new Date(2000).toISOString(), text: 'Due.'}];
  t = setup({timeline: reply});
  t.event('background'); t.event('active'); await flush();
  assert.equal(t.calls.aborts, 1);
  assert.equal(t.ctx.streamingSessionRef.current, null);
  assert.equal(t.ctx.statusRef.current, 'idle');
  assert.equal(t.ctx.closeSessionPauseRef.current, true);
  assert.equal(t.ctx.userInteractedRef.current, false);
  assert.equal(t.calls.timelines.length, 1);
  assert.match(t.calls.errors.at(-1), /chat scritta/);
  t = setup({timeline: [{role: 'ai', timestamp: new Date(500).toISOString()}]});
  t.event('background'); t.event('active'); await flush();
  assert.doesNotMatch(t.calls.errors.at(-1), /chat scritta/, 'old reply is not the interrupted reply');
  let resolve;
  t = setup({deferred: new Promise(r => {resolve = r;})});
  t.event('background'); t.event('active');
  t.ctx.voiceTurnEpochRef.current++; // user starts a new turn
  resolve(reply); await flush();
  assert.equal(t.calls.timelines.length, 0, 'late fetch cannot overwrite a new turn');

  // Also execute the actual player abort listener: no provider/network calls.
  const speech = fs.readFileSync(require('node:path').join(__dirname, '../lib/speech.ts'), 'utf8');
  const a = speech.indexOf('  const onStreamAbort = () => {');
  const b = speech.indexOf('\n\n', a);
  const abortCtx = {ac: new AbortController(), pipelineDone: false, notify: () => {abortCtx.notified = true;}};
  vm.createContext(abortCtx); vm.runInContext(speech.slice(a, b), abortCtx);
  abortCtx.ac.abort();
  assert.equal(abortCtx.pipelineDone, true);
  assert.equal(abortCtx.notified, true, 'cancel wakes the player waiting for audio');
  console.log('PASS: resume recovery, flicker guard, stale fetch, old reply and abort wake-up');
})().catch(e => {console.error(e); process.exitCode = 1;});
