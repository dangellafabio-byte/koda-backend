const assert=require('node:assert/strict');const {prepareDispatch,observeDispatch}=require(process.argv[2]);
(async()=>{let current=true,calls=0,delivered=0,callback;const s={enabled:true,demo:false,isCurrent:()=>current,turn:{account:'a',id:'1',mode:'text',ephemeral:false,text:'Teo'}};const m={context:async()=>{calls++;return '[{"key":"friend.teo","value":"amico"}]'},afterDispatch:(t,cb)=>{callback=cb}};
assert.ok(await prepareDispatch(s,m));assert.equal(await prepareDispatch({...s,enabled:false},m),undefined);assert.equal(await prepareDispatch({...s,demo:true},m),undefined);assert.equal(await prepareDispatch({...s,turn:{...s.turn,mode:'vent'}},m),undefined);assert.equal(await prepareDispatch({...s,turn:{...s.turn,ephemeral:true}},m),undefined);assert.equal(calls,1);assert.equal(await prepareDispatch(s,{...m,context:()=>new Promise(()=>{})},5),undefined);assert.equal(await prepareDispatch(s,{...m,context:async()=>{throw Error()} }),undefined);observeDispatch(s,m,()=>delivered++);callback([]);assert.equal(delivered,1);current=false;callback([]);assert.equal(delivered,1);assert.equal(await prepareDispatch(s,m),undefined);console.log('11 assertions passed');})().catch(e=>{console.error(e);process.exit(1)});

{
  const assert = require('node:assert/strict');
  const { bindLocalObservation } = require(process.argv[2]);
  let active = true;
  const seen = [];
  const receive = bindLocalObservation(() => active, text => seen.push(text));
  receive(' ');
  receive('primo');
  receive('duplicato dal fallback');
  const stale = bindLocalObservation(() => active, text => seen.push(text));
  active = false;
  stale('risposta dopo logout');
  assert.deepEqual(seen, ['primo']);
}
