const assert=require('node:assert/strict');
const {appleEngine}=require(process.argv[2]);
(async()=>{
 const input={utterance:'Teo è un amico',context:[]}; let calls=0;
 for(const capabilities of [async()=>{throw Error('native missing')},async()=>null,async()=>({available:true,italian:true,onDevice:'true',ready:true})]){
  assert.deepEqual(await appleEngine({capabilities,propose:async()=>{calls++;return '[]'}}).propose(input),[]);
 }
 assert.equal(calls,0);
 assert.deepEqual(await appleEngine({capabilities:async()=>({available:true,italian:true,onDevice:true,ready:true}),propose:async()=>{throw Error('native error')}}).propose(input),[]);
 console.log('5 assertions passed');
})().catch(e=>{console.error(e);process.exit(1)});
