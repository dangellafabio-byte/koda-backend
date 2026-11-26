const assert=require('node:assert/strict');
const {openEncryptedMemory,serializedDatabase}=require(process.argv[2]);
(async()=>{
 let events=[],saved=null,enabled=true;
 const conn={execAsync:async s=>{events.push(s.startsWith('PRAGMA key')?'key':s)},getAllAsync:async s=>{events.push(s);return s==='PRAGMA cipher_version'&&enabled?[{cipher_version:'4.6'}]:[]},runAsync:async()=>{},closeAsync:async()=>{events.push('close')}};
 const p={accountHash:async()=> 'a'.repeat(64),randomKey:async()=> 'b'.repeat(64),readKey:async()=>saved,writeKey:async(n,k)=>{saved=k},exists:async()=>false,open:async()=>conn};
 const h=await openEncryptedMemory(p,'account');
 assert.equal(events[0],'key');assert.equal(saved,'b'.repeat(64));assert.ok(events.some(s=>s.startsWith('CREATE TABLE')));await h.close();
 events=[];enabled=false;await assert.rejects(openEncryptedMemory(p,'account'),/SQLCipher/);assert.equal(events.at(-1),'close');assert.ok(!events.some(s=>s.startsWith('CREATE TABLE')));
 await assert.rejects(openEncryptedMemory(p,''),/Account/);
 saved='invalid';await assert.rejects(openEncryptedMemory(p,'account'),/Invalid key/);
 events=[];const db=serializedDatabase(conn);await assert.rejects(db.withExclusiveTransactionAsync(async()=>{throw Error('failure')}),/failure/);assert.deepEqual(events,['BEGIN IMMEDIATE','ROLLBACK']);
 console.log('10 cipher adapter assertions passed (mock only)');
})().catch(e=>{console.error(e);process.exit(1)});
