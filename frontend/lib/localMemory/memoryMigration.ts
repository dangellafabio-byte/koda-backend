import {Fact,Change} from './memoryCore';
/** Import only individually reviewed canonical facts; never overwrite local state. */
export type ImportCandidate={key:string;value:string;approved:boolean};
export function planImport(local:readonly Fact[], candidates:readonly ImportCandidate[], ephemeral=false):Change[]{
 if(ephemeral)return [];
 const occupied=new Set(local.map(f=>f.key));
 const groups=new Map<string,Set<string>>();
 for(const c of candidates){if(c.approved!==true||! /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(c.key)||typeof c.value!=='string')continue;
 const v=c.value.trim();if(!v||v.length>4000)continue;
 const g=groups.get(c.key)??new Set<string>();g.add(v);groups.set(c.key,g);}
 const out:Change[]=[];for(const [key,values] of groups){if(occupied.has(key)||values.size!==1)continue;out.push({key,value:[...values][0],expectedRevision:0,kind:'set',confirmed:true});}return out;
}

export type ImportPreview = Readonly<{key: string; value: string}>;

/** Treat legacy text as a note. Never infer identity or overwrite a canonical fact. */
export async function prepareImportPreview(
  raw: unknown,
  local: readonly Fact[],
  digest: (value: string) => Promise<string>,
): Promise<ImportPreview[]> {
  if (!Array.isArray(raw) || raw.length > 200) throw Error('Invalid import response');
  const occupied = new Set(local.map(fact => fact.key));
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('it');
  const known = new Set(local.filter(fact => !fact.deleted).map(fact => normalize(fact.value)));
  const result: ImportPreview[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.length > 1000 || !item.trim()) continue;
    const canonical = normalize(item);
    if (known.has(canonical)) continue;
    const hash = await digest(canonical);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw Error('Invalid import fingerprint');
    const key = 'legacy.note.' + hash;
    if (!occupied.has(key)) result.push({key, value: item.trim()});
    known.add(canonical);
    occupied.add(key);
  }
  return result;
}
