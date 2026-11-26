const assert=require('node:assert/strict');const {MemoryLifecycle}=require(process.argv[2]);
(async()=>{let opens=0,closes=0,calls=0,deliveries=0,release;const wait=()=>new Promise(r=>setImmediate(r));
const life=new MemoryLifecycle(async()=>{opens++;return {store:{list:async()=>[]},close:async()=>{closes++}}},{capabilities:async()=>({available:true,italian:true,onDevice:true,ready:true}),propose:async()=>{calls++;await new Promise(r=>release=r);return JSON.stringify([{key:'friend.teo',value:'amico',evidence:'Teo'}]);}});
const t={account:'a',id:'1',mode:'text',ephemeral:false,text:'Teo è un amico'};const deliver=()=>deliveries++;
assert.equal(await life.context(t),'[]');await life.switchAccount('a');assert.equal(opens,1);
life.afterDispatch({...t,mode:'vent'},deliver);await wait();assert.equal(calls,0);
life.afterDispatch(t,deliver);await wait();assert.equal(calls,1);life.afterDispatch(t,deliver);assert.equal(calls,1);
const logout=life.switchAccount(null);release();await logout;assert.equal(deliveries,0);assert.equal(closes,1);
await life.switchAccount('b');life.afterDispatch(t,deliver);await wait();assert.equal(calls,1);assert.equal(await life.context(t),'[]');await life.switchAccount(null);assert.equal(closes,2);console.log('10 assertions passed');})().catch(e=>{console.error(e);process.exit(1)});
