import {MemoryDatabase, MemoryStore} from './memoryStore';
type Args = (string|number)[];
export interface CipherConnection {
 execAsync(sql:string):Promise<void>;
 getAllAsync<T>(sql:string,...args:Args):Promise<T[]>;
 runAsync(sql:string,...args:Args):Promise<unknown>;
 closeAsync():Promise<void>;
}
export interface CipherPlatform {
 accountHash(account:string):Promise<string>;
 randomKey():Promise<string>;
 readKey(name:string):Promise<string|null>;
 writeKey(name:string,key:string):Promise<void>;
 exists(name:string):Promise<boolean>;
 open(name:string):Promise<CipherConnection>;
}
// Serialize every operation on the keyed connection. Do not use a transaction
// helper that silently opens a second, unkeyed SQLite connection.
export function serializedDatabase(conn:CipherConnection):MemoryDatabase & {close:()=>Promise<void>} {
 let tail:Promise<unknown>=Promise.resolve();
 let closing:Promise<void>|undefined;
 const queue=<T>(fn:()=>Promise<T>):Promise<T>=>{
  if(closing) return Promise.reject(Error('Memory database closed'));
  const next=tail.then(fn); tail=next.catch(()=>{}); return next;
 };
 const direct:MemoryDatabase={
  execAsync:s=>conn.execAsync(s),getAllAsync:<T>(s:string,...a:Args)=>conn.getAllAsync<T>(s,...a),
  runAsync:(s,...a)=>conn.runAsync(s,...a),
  withExclusiveTransactionAsync:async()=>{throw Error('Nested transaction unsupported');}
 };
 return {
  close:()=>closing??=(tail.then(()=>conn.closeAsync())),
  execAsync:s=>queue(()=>direct.execAsync(s)),
  getAllAsync:<T>(s:string,...a:Args)=>queue(()=>direct.getAllAsync<T>(s,...a)),
  runAsync:(s,...a)=>queue(()=>direct.runAsync(s,...a)),
  withExclusiveTransactionAsync:task=>queue(async()=>{
   await conn.execAsync('BEGIN IMMEDIATE');
   try {await task(direct);await conn.execAsync('COMMIT');}
   catch(e){await conn.execAsync('ROLLBACK');throw e;}
  })
 };
}
// Caller must retain one handle per account, drain operations before closing,
// and never invoke this for ephemeral or vent-room conversations.
export async function openEncryptedMemory(platform:CipherPlatform,account:string) {
 if(!account.trim()) throw Error('Account required');
 const hash=await platform.accountHash(account);
 if(!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid account hash');
 const name='ollenya_memory_'+hash;
 let key=await platform.readKey(name);
 if(key===null){if(await platform.exists(name+'.db'))throw Error('Recovery required: missing key');key=await platform.randomKey();if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid key');await platform.writeKey(name,key);}
 if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid key');
 const conn=await platform.open(name+'.db');
 try {
  await conn.execAsync(`PRAGMA key = "x'${key}'"`);
  const cipher=await conn.getAllAsync<Record<string,unknown>>('PRAGMA cipher_version');
  if(!cipher.some(r=>typeof r.cipher_version==='string'&&r.cipher_version.length>0))throw Error('SQLCipher unavailable');
  await conn.getAllAsync('SELECT count(*) FROM sqlite_master');
  await conn.execAsync('PRAGMA secure_delete = ON');
  const database=serializedDatabase(conn);
  const store=new MemoryStore(database,account);
  await store.init();
  return {store,close:database.close};
 }catch(e){await conn.closeAsync();throw e;}
}
