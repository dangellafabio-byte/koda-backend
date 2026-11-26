import {Fact, Change} from './memoryCore';
import {LocalSemanticEngine} from './memoryEngine';
import {stageProfile} from './memoryProfile';
import {recall} from './memoryRetrieval';
export type Turn = {account:string; id:string; mode:'text'|'ptt'|'hands-free'|'vent'; ephemeral:boolean; text:string};
export interface AccountMemory {account:string; list():Promise<Fact[]>}
/** Per-account coordinator. No network, no automatic writes, no audio access. */
export class ConversationMemory {
 private generation=0;
 constructor(private store:AccountMemory,private engine?:LocalSemanticEngine){}
 invalidate(){this.generation++;}
 private allowed(t:Turn){return t.account===this.store.account && !t.ephemeral && t.mode!=='vent' && !!t.text.trim();}
 async context(t:Turn):Promise<string>{
  if(!this.allowed(t))return '[]'; const g=this.generation;
  try{const facts=await this.store.list();return g===this.generation?recall(facts,t.text,{ephemeral:false}):'[]';}catch{return '[]';}
 }
 /** Invoke after response dispatch, outside the audio critical path. */
 async proposals(t:Turn):Promise<Change[]>{
  if(!this.allowed(t)||this.engine?.onDevice!==true)return [];const g=this.generation;
  try{const facts=await this.store.list();if(g!==this.generation)return [];
   const context=JSON.parse(recall(facts,t.text,{ephemeral:false}));
   const raw=await this.engine.propose({utterance:t.text,context});
   if(g!==this.generation)return [];
   return stageProfile(raw,t.text,facts,false);
  }catch{return [];}
 }
}
