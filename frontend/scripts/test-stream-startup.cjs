const fs=require('fs'),path=require('path'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../lib/speech.ts'),'utf8'),ast=ts.createSourceFile('speech.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='voiceStreamConverse');assert(fn);
const code=ts.transpileModule(fn.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()}};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
function harness(mode){const hold=deferred(),calls=[],refs=[];let callbacks;
 class Session{constructor(cb){callbacks=cb;calls.push('construct')}static async isSupported(){if(mode==='probe')await hold.promise;return {supported:true}}async start(){calls.push('start');if(mode==='error')throw Error('synthetic failure');if(mode==='done')callbacks.onDone()}async abort(){calls.push('abort')}async stop(){calls.push('stop')}}
 const ctx={exports:{},AbortController,Promise,Date,Map,Uint8Array,console:{log(){},warn(){}},process:{env:{EXPO_PUBLIC_USE_CLIENT_STT:'true'}},Platform:{OS:'android'},OLLENYA_DEBUG_VERBOSE:false,setTimeout(){return 1},clearTimeout(){},stopAllPlayback(){},speakingNow:false,currentAbort:null,
 require(name){if(name==='./voiceStream')return {VoiceStreamSession:Session};if(name==='./voiceClientStt')return {VoiceClientSttSession:Session};if(name==='./geolocation')return {refreshLocationSilent:async()=>{if(mode==='geo')await hold.promise},getCachedLocation:()=>null};throw Error(name)}};
 vm.createContext(ctx);vm.runInContext(code,ctx);return {ctx,hold,calls,run:()=>ctx.exports.voiceStreamConverse({onSession:s=>refs.push(s)}),refs};}
(async()=>{for(const mode of ['probe','geo']){const h=harness(mode),work=h.run();await flush();h.ctx.currentAbort.abort();h.hold.resolve();assert.equal((await work).error,'aborted');assert(!h.calls.includes('start'));assert.equal(h.ctx.currentAbort,null);assert.equal(h.ctx.speakingNow,false)}
 let h=harness('error');assert((await h.run()).error.includes('synthetic failure'));assert(h.calls.includes('abort'));assert.equal(h.refs.at(-1),null);
 h=harness('waiting');const work=h.run();await flush();h.ctx.currentAbort.abort();assert.equal((await work).error,'aborted');assert(h.calls.includes('abort'));
 h=harness('done');assert.equal((await h.run()).ok,true);
 console.log('PASS stream: actual probe/GPS cancellation, failed native-start cleanup, abort wakes first-sentence wait, normal completion');
})().catch(e=>{console.error(e);process.exitCode=1});
