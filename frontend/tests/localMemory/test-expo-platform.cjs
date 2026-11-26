const assert=require('node:assert/strict');
const {expoCipherPlatform,createExpoMemoryInitializer}=require(process.argv[2]);
(async()=>{
 let saved=null,exists=true,opens=0,random=0,options;
 const conn={execAsync:async()=>{},getAllAsync:async s=>s==='PRAGMA cipher_version'?[{cipher_version:'4'}]:[],runAsync:async()=>{},closeAsync:async()=>{}};
 const m={crypto:{digestStringAsync:async()=> 'a'.repeat(64),getRandomBytesAsync:async n=>{random++;return new Uint8Array(n).fill(15)}},secure:{getItemAsync:async()=>saved,setItemAsync:async(n,k,o)=>{saved=k;options=o},WHEN_UNLOCKED_THIS_DEVICE_ONLY:6},sqlite:{defaultDatabaseDirectory:'file:///db',openDatabaseAsync:async(n,o,d)=>{opens++;assert.equal(o.useNewConnection,true);return conn}},fileExists:async uri=>{assert.ok(uri.startsWith('file:///db/'));return exists}};
 const p=expoCipherPlatform(m);assert.equal(await p.accountHash('a'),'a'.repeat(64));
 const init=createExpoMemoryInitializer(m);await assert.rejects(init('a'),/Recovery required/);assert.equal(random,0);assert.equal(opens,0);
 exists=false;const a=init('a'),b=init('a');assert.equal(a,b);await a;assert.equal(opens,1);assert.equal(random,1);assert.equal(saved,'0f'.repeat(32));assert.equal(options.keychainAccessible,6);
 const first=await a;
 let release;conn.closeAsync=()=>new Promise(resolve=>{release=resolve});
 const closed=first.close();const reopened=init('a');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(opens,1);
 release();await closed;const second=await reopened;assert.notEqual(first,second);assert.equal(opens,2);
 assert.equal(await init('a'),second);
 await first.close();assert.equal(await init('a'),second);
 console.log('Expo adapter mock tests passed');
})().catch(e=>{console.error(e);process.exit(1)});
