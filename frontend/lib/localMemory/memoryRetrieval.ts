import {Fact} from './memoryCore';
import {rankProfile} from './memoryProfile';
export type Recall = {key:string;value:string};
/** Local ranking, with optional semantic keys supplied by a trusted local adapter.
 * The serialized payload (including JSON overhead) is bounded in UTF-8 bytes. */
export function recall(facts:readonly Fact[], query:string, options:{ephemeral:boolean; maxBytes?:number; maxFacts?:number; semanticKeys?:readonly string[]}): string {
 const budget=options.maxBytes??2048, limit=options.maxFacts??12;
 if(!Number.isSafeInteger(budget)||budget<2||!Number.isSafeInteger(limit)||limit<0) throw Error('Invalid recall budget');
 if(options.ephemeral||!query.trim()) return '[]';
 const byKey=new Map(facts.filter(f=>!f.deleted).map(f=>[f.key,f]));
 const ranked=[...new Set([...rankProfile(facts,query),...(options.semanticKeys??[])])];
 const result:Recall[]=[];
 const bytes=(s:string)=>Array.from(s).reduce((n,c)=>{const p=c.codePointAt(0)!;return n+(p<128?1:p<2048?2:p<65536?3:4)},0);
 for(const key of ranked){if(result.length>=limit)break;const f=byKey.get(key);if(!f)continue;const next={key:f.key,value:f.value};if(bytes(JSON.stringify([...result,next]))<=budget)result.push(next);}
 return JSON.stringify(result);
}
