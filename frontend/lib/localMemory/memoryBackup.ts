import {Fact} from './memoryCore';
// Native adapter must implement authenticated encryption, e.g. AES-256-GCM,
// fresh nonce per seal, and a recoverable key kept separately from ciphertext.
export interface BackupCrypto {
 seal(plaintext:string, associatedData:string):Promise<string>;
 open(ciphertext:string, associatedData:string):Promise<string>;
}
const MAX=64*1024*1024;
function aad(account:string){if(!account.trim())throw Error('Account required');return JSON.stringify(['ollenya-memory',1,account]);}
function validate(input:unknown):Fact[]{
 if(!Array.isArray(input)||input.length>100000)throw Error('Invalid facts');
 const seen=new Set<string>();
 return input.map(f=>{if(!f||typeof f.key!=='string'||!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(f.key)||seen.has(f.key)||typeof f.value!=='string'||f.value.length>4000||!Number.isSafeInteger(f.revision)||f.revision<1||typeof f.deleted!=='boolean'||(f.deleted?f.value!=='':!f.value.trim()))throw Error('Invalid fact');seen.add(f.key);return {key:f.key,value:f.value,revision:f.revision,deleted:f.deleted};});
}
export async function createBackup(account:string,facts:readonly Fact[],crypto:BackupCrypto):Promise<string>{
 const context=aad(account);const payload=JSON.stringify({version:1,facts:validate(facts)});if(payload.length>MAX)throw Error('Backup too large');return crypto.seal(payload,context);
}
export async function readBackup(account:string,ciphertext:string,crypto:BackupCrypto):Promise<Fact[]>{
 if(!ciphertext||ciphertext.length>MAX*8)throw Error('Invalid backup size');const raw=await crypto.open(ciphertext,aad(account));if(raw.length>MAX)throw Error('Backup too large');const data=JSON.parse(raw);if(data?.version!==1)throw Error('Unsupported version');return validate(data.facts);
}
// Restore only into a verified fresh account store. Never merge over existing state.
export function planFreshRestore(local:readonly Fact[],backup:readonly Fact[]):Fact[]{if(local.length)throw Error('Existing memory: restore blocked');return validate(backup);}
