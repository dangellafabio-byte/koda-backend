import {ConversationMemory, Turn} from './memoryConversation';
import {Change} from './memoryCore';
import {MemoryStore} from './memoryStore';
import {AppleBridge, appleEngine} from './memoryApple';
import {localItalianEngine} from './memoryLocalItalian';
type Handle={store:MemoryStore;close:()=>Promise<void>};
/** Experimental lifecycle; no writes, network or audio access. */
export class MemoryLifecycle {
 private epoch=0;
 private active?:{account:string;handle:Handle;memory:ConversationMemory};
 private tail:Promise<unknown>=Promise.resolve();
 private busy=false;
 constructor(private open:(account:string)=>Promise<Handle>,private bridge?:AppleBridge){}
 private queue<T>(fn:()=>Promise<T>):Promise<T>{const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p;}
 switchAccount(account:string|null):Promise<void>{
  const g=++this.epoch;this.active?.memory.invalidate();
  return this.queue(async()=>{
   const old=this.active;this.active=undefined;if(old)await old.handle.close();
   if(!account||g!==this.epoch)return;
   const handle=await this.open(account);
   if(g!==this.epoch){await handle.close();return;}
   this.active={account,handle,memory:new ConversationMemory({account,list:()=>handle.store.list()},this.bridge?appleEngine(this.bridge):localItalianEngine)};
  });
 }
 private allowed(t:Turn){return !t.ephemeral&&t.mode!=='vent'&&this.active?.account===t.account;}
 context(t:Turn):Promise<string>{const g=this.epoch;if(!this.allowed(t))return Promise.resolve('[]');return this.queue(async()=>g===this.epoch&&this.allowed(t)?this.active!.memory.context(t):'[]').then(v=>g===this.epoch?v:'[]');}
 /** Call after dispatch; drop overlapping jobs rather than retain private text in a backlog. */
 afterDispatch(t:Turn,deliver:(changes:Change[])=>void):void{
  if(t.ephemeral||t.mode==='vent'){this.invalidate();return;}
  if(this.busy||!this.allowed(t))return;
  const g=this.epoch;this.busy=true;
  void this.queue(async()=>{if(g!==this.epoch||!this.allowed(t))return;const changes=await this.active!.memory.proposals(t);if(g===this.epoch&&changes.length)deliver(changes);}).catch(()=>{}).finally(()=>{this.busy=false;});
 }
 invalidate(){this.epoch++;this.active?.memory.invalidate();}
}
