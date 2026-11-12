const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),ts=require('typescript');
const compile=(s,f='x.ts')=>ts.transpileModule(s,{fileName:f,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
function nativeHarness(checkpoint) {
 const hold=deferred(),reached=deferred(),calls=[],timers=new Map();let id=0,socket;
 async function stage(name,result){calls.push(name);if(checkpoint===name){reached.resolve();await hold.promise}return result}
 class WS {constructor(){socket=this;this.readyState=0}close(){calls.push('close');this.readyState=3}}
 const ctx={exports:{},Date,Promise,AbortController,Uint8Array,ArrayBuffer,WebSocket:WS,console:{log(){},warn(){}},
 setTimeout(fn,ms){const n=++id;if([80,100,250,300].includes(ms))queueMicrotask(fn);else timers.set(n,{fn,ms});return n},clearTimeout:n=>timers.delete(n),setInterval(){},clearInterval(){},
 fetch:async(url,opts)=>{assert.equal(url,'https://example.invalid/api/voice/warmup');calls.push('fetch');if(checkpoint==='fetch'){reached.resolve();await new Promise((resolve,reject)=>{opts.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true});hold.promise.then(resolve)})}},
 require(name){
 if(name==='react-native')return {Platform:{OS:'android'},AppState:{currentState:'active'}};
 if(name==='expo-speech-recognition')return {ExpoSpeechRecognitionModule:{abort(){},stop(){}}};
 if(name==='expo-audio')return {setIsAudioActiveAsync:v=>stage(v?'activate':'deactivate'),setAudioModeAsync:()=>stage('mode')};
 if(name==='./voiceStream')return {detectAudioRouteDetailed:()=>stage('route',{route:'builtin'})};
 if(name==='./backendUrl')return {kodaBackendWsUrl:()=> 'wss://example.invalid/api/voice/stream'};
 if(name==='./authToken')return {getAuthToken:()=> 'synthetic-token'};
 return {};
 }};
 vm.createContext(ctx);vm.runInContext(compile(read('lib/voiceClientStt.ts')),ctx);
 const Ctor=ctx.exports.VoiceClientSttSession;Ctor.requestPermissions=()=>stage('permission',{granted:true});
 const session=new Ctor({onError:e=>calls.push('error:'+e)});
 session.sendJson=()=>calls.push('send');session.startKeepalive=()=>{};session.stopKeepalive=()=>{};
 session.startRecognition=async()=>{calls.push('recognize')};
 const actualOpen=session.openWs.bind(session);session.openWs=()=>stage('ws');
 return {session,calls,hold,reached,actualOpen,timers,get socket(){return socket}};
}
(async()=>{
 for(const action of ['stop','abort']){
  let h=nativeHarness();await h.session[action]();await assert.rejects(h.session.start(),/start_cancelled/);assert(!h.calls.includes('permission'));
  for(const point of ['permission','deactivate','mode','activate','route','fetch','ws']){
   h=nativeHarness(point);const start=h.session.start().then(()=>null,e=>e);await h.reached.promise;
   await h.session[action]();const count=h.calls.length;h.hold.resolve();assert.equal((await start).message,'voice_stream_start_cancelled');assert.deepEqual(h.calls.slice(count),[]);
  }
 }
 let h=nativeHarness();await h.session.start();assert(h.calls.includes('recognize'));
 for(const operation of ['performAudioSessionRecoveryCycle','dispatchFinalToBackend']){
  h=nativeHarness('deactivate');h.session.currentTranscript='Prova';const task=h.session[operation]('audio','synthetic',true);await h.reached.promise;
  let done=false;const abort=h.session.abort().then(()=>{done=true});await flush();assert.equal(done,false);
  const count=h.calls.length;h.hold.resolve();await task;await abort;assert.deepEqual(h.calls.slice(count),[]);
 }
 for(const event of ['close','error','timeout','abort','open']){
  h=nativeHarness();const opening=h.actualOpen('wss://example.invalid').then(()=>null,e=>e);
  assert.equal(h.session.ws,h.socket,'connecting socket is owned immediately');
  if(event==='close')h.socket.onclose({code:1000});
  if(event==='error')h.socket.onerror({});
  if(event==='timeout')[...h.timers.values()].find(t=>t.ms===10000).fn();
  if(event==='abort')await h.session.abort();
  if(event==='open')h.socket.onopen();
  const error=await opening;assert.equal(error===null,event==='open');assert.equal(h.timers.size,0);
  if(event!=='open'){h.socket.onopen();assert(!h.calls.includes('recognize'),'late open cannot start recognition')}
 }
 console.log('PASS native: pre-start stop, seven async boundaries, focus teardown, socket close/error/timeout/abort/late-open, normal start');

 const gateCtx={exports:{},Promise};vm.createContext(gateCtx);vm.runInContext(compile(read('lib/audioLifecycleGate.ts')),gateCtx);const Gate=gateCtx.exports.AudioLifecycleGate;
 let gate=new Gate(),hold=deferred(),events=[];
 const cleanup=gate.runIdle(()=>true,async current=>{events.push('release-start');await hold.promise;events.push('release-end');if(current())events.push('disable')});await flush();
 const lease=gate.claimVoice();let prepared=false;const prep=lease.ready.then(()=>{prepared=true;events.push('prepare')});await flush();assert.equal(prepared,false);hold.resolve();await cleanup;await prep;
 assert.deepEqual(events,['release-start','release-end','prepare']);assert.equal(gate.claimVoice(),null);lease.release();
 gate=new Gate();const active=gate.claimVoice();events=[];const reset=gate.runIdle(()=>true,async()=>events.push('reset'));await flush();assert.deepEqual(events,[]);active.release();await reset;assert.deepEqual(events,['reset']);
 gate=new Gate();events=[];const queued=gate.runIdle(()=>true,async()=>events.push('stale'));const next=gate.claimVoice();await next.ready;await queued;assert.deepEqual(events,[]);next.release();
 console.log('PASS gate: in-flight cleanup drains before prepare; stale cleanup skipped; reset waits; single voice owner');

 const screen=read('app/index.tsx'),ast=ts.createSourceFile('index.tsx',screen,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback,internal,startup;
 function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='AppState.addEventListener'&&n.arguments[1]?.getText(ast).includes('audioLifecycleGateRef'))callback=n.arguments[1];if(ts.isVariableDeclaration(n)){if(n.name.getText(ast)==='startTalkInternal')internal=n.initializer;if(n.name.getText(ast)==='startTalkStreaming')startup=n.initializer}ts.forEachChild(n,visit)}visit(ast);assert(callback&&internal&&startup);
 const startText=startup.getText(ast);assert(startText.indexOf('claimVoice()')<startText.indexOf('await audioLease.ready'));assert(startText.indexOf('await audioLease.ready')<startText.indexOf('await prewarmMic()'));assert(startText.includes('finally { audioLease.release(); }'));
 // Execute actual lifecycle callback while the lease exists but sessionRef does not.
 gate=new Gate();const owned=gate.claimVoice();const ctx={exports:{},audioLifecycleGateRef:{current:gate},observedAppStateRef:{current:'active'},wasActuallyBackgroundedRef:{current:false},statusRef:{current:'idle'},streamingSessionRef:{current:null},recRef:{current:null},OLLENYA_DEBUG_VERBOSE:false,console:{log(){}},userInteractedRef:{current:true}};
 vm.createContext(ctx);vm.runInContext(compile('exports.change='+callback.getText(ast)),ctx);ctx.exports.change('inactive');ctx.exports.change('active');assert.equal(ctx.statusRef.current,'idle');assert.equal(ctx.userInteractedRef.current,true);owned.release();
 // Execute permission/start prefix from the actual screen, with a delayed permission.
 const prefix=internal.getText(ast).split('    // === MUTEX')[0]+'return "proceed";\n}';
 for(const kind of ['released','new-gesture','hard-stop','held']){
  hold=deferred();const c={exports:{},ensureSpeechPermission:()=>hold.promise,voiceTurnEpochRef:{current:1},pttGestureEpochRef:{current:4},pttRecordingRef:{current:true},console:{log(){},warn(){}}};vm.createContext(c);vm.runInContext(compile('exports.run='+prefix),c);
  const result=c.exports.run(false);if(kind==='released')c.pttRecordingRef.current=false;if(kind==='new-gesture')c.pttGestureEpochRef.current++;if(kind==='hard-stop')c.voiceTurnEpochRef.current++;
  hold.resolve({granted:true});assert.equal(await result,kind==='held'?'proceed':undefined);
 }
 console.log('PASS screen: real AppState callback protects startup; PTT released/replaced or hard-stopped during permissions never proceeds');
})().catch(e=>{console.error(e);process.exitCode=1});
