import {CipherPlatform, CipherConnection, openEncryptedMemory} from './memoryEncryptedDb';
// Structural interfaces allow testing without loading native modules on Node.
export interface ExpoMemoryModules {
 crypto:{digestStringAsync(algorithm:'SHA-256',value:string):Promise<string>;getRandomBytesAsync(length:number):Promise<Uint8Array>};
 secure:{getItemAsync(name:string):Promise<string|null>;setItemAsync(name:string,value:string,options:{keychainAccessible:number}):Promise<void>;WHEN_UNLOCKED_THIS_DEVICE_ONLY:number};
 sqlite:{defaultDatabaseDirectory:string;openDatabaseAsync(name:string,options:{useNewConnection:boolean},directory:string):Promise<CipherConnection>};
 fileExists(uri:string):Promise<boolean>;
}
export function expoCipherPlatform(m:ExpoMemoryModules):CipherPlatform {
 const directory=m.sqlite.defaultDatabaseDirectory;
 return {
 accountHash:account=>m.crypto.digestStringAsync('SHA-256',account),
 randomKey:async()=>Array.from(await m.crypto.getRandomBytesAsync(32),b=>b.toString(16).padStart(2,'0')).join(''),
 readKey:name=>m.secure.getItemAsync(name),
 writeKey:(name,key)=>m.secure.setItemAsync(name,key,{keychainAccessible:m.secure.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
 exists:name=>m.fileExists(directory.replace(/\/$/,'')+'/'+name),
 open:name=>m.sqlite.openDatabaseAsync(name,{useNewConnection:true},directory)
 };
}
// Share one keyed connection per account until its queued operations drain.
export function createExpoMemoryInitializer(m:ExpoMemoryModules){
 const platform=expoCipherPlatform(m);
 const handles=new Map<string,ReturnType<typeof openEncryptedMemory>>();
 const closing=new Map<string,Promise<void>>();

 function initialize(account:string):ReturnType<typeof openEncryptedMemory>{
  const pendingClose=closing.get(account);
  if(pendingClose) return pendingClose.then(()=>initialize(account));
  const existing=handles.get(account);
  if(existing)return existing;
  const pending=openEncryptedMemory(platform,account).then(handle=>({
   store:handle.store,
   close:()=>{
    const previous=closing.get(account);
    if(previous && handles.get(account)===pending)return previous;
    // A stale handle must never close or evict a newly opened connection.
    if(handles.get(account)!==pending)return handle.close();
    const end=handle.close().then(()=>{
     handles.delete(account);
     closing.delete(account);
    });
    closing.set(account,end);
    return end;
   },
  }));
  handles.set(account,pending);
  void pending.catch(()=>{if(handles.get(account)===pending)handles.delete(account);});
  return pending;
 }
 return initialize;
}
