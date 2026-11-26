import {Turn} from './memoryConversation';
import {Change} from './memoryCore';
export interface DispatchMemory {
 context(turn:Turn):Promise<string>;
 afterDispatch(turn:Turn,deliver:(changes:Change[])=>void):void;
}
export type DispatchScope = {enabled:boolean;demo:boolean;turn:Turn;isCurrent:()=>boolean};
function allowed(s:DispatchScope){return s.enabled&&!s.demo&&!s.turn.ephemeral&&s.turn.mode!=='vent'&&s.isCurrent();}
/** Optional context only; never delays transport beyond the configured deadline. */
export async function prepareDispatch(s:DispatchScope,m?:DispatchMemory,deadlineMs=40):Promise<string|undefined>{
 if(!m||!allowed(s))return undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const value=await Promise.race([m.context(s.turn),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),deadlineMs);})]);
  return allowed(s)&&value&&value!=='[]'?value:undefined;
 }catch{return undefined;}finally{if(timer!==undefined)clearTimeout(timer);}
}
/** Only call after successful transport dispatch, never on partial STT. */
export function observeDispatch(s:DispatchScope,m:DispatchMemory|undefined,deliver:(changes:Change[])=>void):void{
 if(!m||!allowed(s))return;
 try{m.afterDispatch(s.turn,changes=>{if(allowed(s))deliver(changes);});}catch{}
}

/** Bind a final successful dispatch to the account and turn that began it. */
export function bindLocalObservation(
  isCurrent: () => boolean,
  observe: (text: string) => void,
): (text: string) => void {
  let dispatched = false;
  return text => {
    if (dispatched || !isCurrent() || !text.trim()) return;
    dispatched = true;
    observe(text);
  };
}
