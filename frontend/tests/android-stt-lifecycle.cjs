// Run from frontend: node tests/android-stt-lifecycle.cjs
// Uses TypeScript (already a devDependency) and native-module mocks; no API calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_MODULE || 'typescript');
const source = fs.readFileSync(process.env.STT_SOURCE || path.join(__dirname, '../lib/voiceClientStt.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
}, reportDiagnostics: true });
assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
function harness(os = 'android') {
  const listeners = new Map(), timers = new Map(), frames = [], errors = [];
  let id = 0, active = 0, closed = 0, started = 0, options;
  const emit = (name, event) => [...(listeners.get(name) || [])].forEach(cb => cb(event));
  const native = {
    addListener(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return { remove: () => listeners.get(name).delete(cb) };
    },
    abort() {}, stop() {},
    start(opts) { started++; options = opts; },
  };
  const audio = { setAudioModeAsync: async () => {}, setIsAudioActiveAsync: async () => {} };
  const exports = {};
  const context = {
    exports, console: {log(){}}, WebSocket: {OPEN:1}, Date, Promise,
    setTimeout(cb, ms) { const n=++id; if(ms === 80) queueMicrotask(cb); else timers.set(n,{cb,ms}); return n; },
    clearTimeout(n) {timers.delete(n)}, clearInterval() {}, setInterval(){return ++id},
    require(name) {
      if(name === 'react-native') return {Platform:{OS:os}, AppState:{currentState:'active'}};
      if(name === 'expo-speech-recognition') return {ExpoSpeechRecognitionModule:native};
      if(name === 'expo-audio') return audio;
      if(['./voiceStream','./backendUrl','./authToken'].includes(name)) return {};
      throw new Error(name);
    },
  };
  vm.runInNewContext(compiled.outputText, context);
  const session = new exports.VoiceClientSttSession({
    onRecognitionActive(){active++}, onError(e){errors.push(e)}, onFinal(){}, onInterim(){},
  });
  session.ws = {readyState:1, send(frame){frames.push(JSON.parse(frame))},close(){closed++}};
  const fireWatchdog = () => { for(const [n,t] of [...timers]) if(t.ms===5000){timers.delete(n);t.cb()} };
  return {session,emit,errors,frames,fireWatchdog,
    get active(){return active},get closed(){return closed},get options(){return options},
    get started(){return started},get listenerCount(){return [...listeners.values()].reduce((n,s)=>n+s.size,0)}};
}
let passed=0;
async function test(name, fn) {await fn();passed++;console.log('PASS', name)}
(async () => {
  await test('Android uses standard microphone and does not require offline models', async()=>{
    const h=harness();await h.session.startRecognition('it');
    assert.equal(h.options.continuous,false);assert.equal(h.options.requiresOnDeviceRecognition,false);
    assert.equal(h.options.lang,'it-IT');assert.equal(h.active,0);
  });
  await test('native readiness opens UI gate once; user silence is not startup failure', async()=>{
    const h=harness();await h.session.startRecognition('it');
    h.emit('start');h.emit('start');h.fireWatchdog();assert.equal(h.active,1);assert.deepEqual(h.errors,[]);
  });
  await test('missing native readiness fails once and cleans listeners/socket', async()=>{
    const h=harness();await h.session.startRecognition('it');h.fireWatchdog();h.emit('start');
    assert.deepEqual(h.errors,['android_mic_silent_fail']);assert.equal(h.listenerCount,0);assert.equal(h.closed,1);assert.equal(h.active,0);
  });
  await test('end without transcript cannot leave recording zombie', async()=>{
    const h=harness();await h.session.startRecognition('it');h.emit('end');h.emit('end');h.fireWatchdog();
    assert.deepEqual(h.errors,['client_stt_ended_without_transcript']);assert.equal(h.listenerCount,0);assert.equal(h.closed,1);
  });
  await test('native audio error closes old session before next turn', async()=>{
    const h=harness();await h.session.startRecognition('it');h.emit('error',{error:'audio-capture'});h.emit('end');
    assert.deepEqual(h.errors,['client_stt_audio-capture']);assert.equal(h.listenerCount,0);assert.equal(h.closed,1);
  });
  await test('no-speech remains a clean empty turn', async()=>{
    const h=harness();await h.session.startRecognition('it');h.emit('error',{error:'no-speech'});h.emit('end');
    assert.deepEqual(h.errors,['no_speech']);assert.equal(h.listenerCount,0);assert.equal(h.closed,1);
  });
  await test('partial text on native end reaches backend exactly once', async()=>{
    const h=harness();await h.session.startRecognition('it');
    h.emit('result',{isFinal:false,results:[{transcript:'Ciao Ollenya',confidence:0.9}]});h.emit('end');h.emit('end');
    assert.equal(h.frames.filter(f=>f.type==='transcript_from_client').length,1);
    assert.equal(h.frames[0].text,'Ciao Ollenya');assert.equal(h.frames[0].stt_engine,'google_speechrecognizer');
  });
  await test('cancel during async Android reset never restarts microphone', async()=>{
    const h=harness();const pending=h.session.startRecognition('it');await h.session.abort();await pending;
    assert.equal(h.started,0);assert.equal(h.listenerCount,0);
  });
  await test('iOS options and immediate readiness remain unchanged', async()=>{
    const h=harness('ios');await h.session.startRecognition('it');
    assert.equal(h.options.requiresOnDeviceRecognition,true);assert.equal(h.options.continuous,false);
    assert.equal(h.options.iosCategory.category,'playAndRecord');assert.equal(h.active,1);
  });
  for (const os of ['android', 'ios']) {
    await test(`${os} permission warning names the correct platform`, async()=>{
      let body;
      const out = {};
      const source = fs.readFileSync(path.join(__dirname,'../lib/speechPermission.ts'),'utf8');
      const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
      vm.runInNewContext(js,{exports:out,console,require(name){
        if(name==='react-native') return {Platform:{OS:os},Linking:{},Alert:{alert(_title,text,buttons){body=text;buttons[0].onPress()}}};
        if(name==='expo-speech-recognition') return {ExpoSpeechRecognitionModule:{getPermissionsAsync:async()=>({granted:false,canAskAgain:false})}};
        throw Error(name);
      }});
      const result=await out.ensureSpeechPermission();assert.equal(result.granted,false);
      assert.equal(body.includes('iOS'),os==='ios');
    });
  }
  // Parse every changed TS/TSX file too (no native dependencies needed).
  for(const file of ['components/OnboardingV4.tsx','components/MicroDemoOllenya.tsx',
    'components/OllenyaIntroV3.tsx','components/OllenyaIntroConversational.tsx','lib/speechPermission.ts']) {
    const src=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    const result=ts.transpileModule(src,{fileName:file,compilerOptions:{jsx:ts.JsxEmit.React},reportDiagnostics:true});
    assert.equal(result.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).length,0,file);
  }
  console.log(`${passed} lifecycle tests passed; 6 changed source files parsed.`);
})().catch(e=>{console.error(e);process.exitCode=1});
