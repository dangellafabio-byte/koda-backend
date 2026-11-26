import {Fact, Change} from './memoryCore';
import {validateProposals} from './memoryEngine';
/** A derived portrait, never a second authoritative copy of personal facts. */
export function portrait(facts: readonly Fact[]): Record<string, Fact[]> {
 const groups: Record<string, Fact[]> = Object.create(null);
 for (const f of facts) { if (f.deleted) continue; const group=f.key.split(/[.:]/)[0]; (groups[group] ??= []).push({...f}); }
 return groups;
}
/** Stage changes for independent authorization; never write directly from model output. */
export function stageProfile(raw: unknown, utterance: string, facts: readonly Fact[], ephemeral: boolean): Change[] {
 if (ephemeral) return [];
 const byKey=new Map(facts.map(f=>[f.key,f]));
 return validateProposals(raw,utterance).flatMap(p=>{
 const old=byKey.get(p.key);
 if (old?.deleted || old?.value===p.value) return [];
 return [{key:p.key,value:p.value,expectedRevision:old?.revision??0,kind:'set' as const,confirmed:false}];
 });
}
const words = (text: string) => new Set(text.toLocaleLowerCase('it').normalize('NFD')
  .replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 2));

const recallIntents: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdove (?:abito|vivo)\b/iu, 'home.city'],
  [/\b(?:il mio (?:gatto|cane)|la mia (?:gatta|micia|cagnolina))\b/iu, 'pet.name'],
  [/\b(?:che|quale) strumento suono\b/iu, 'hobby.music'],
];

/** Prefer a recognized local intent and disambiguate candidates by shared terms. */
export function rankProfile(facts: readonly Fact[], query: string): string[] {
  if (/^\s*non (?:voglio parlare|parliamo|parlare|menzionare|citare)\b/iu.test(query)) return [];
  const active = facts.filter(fact => !fact.deleted);
  const intent = recallIntents.find(([pattern]) => pattern.test(query));
  if (intent) {
    const key = intent[1];
    if (active.some(fact => fact.key === key)) return [key];
    if (key === 'pet.name') {
      const pets = active.filter(fact => fact.key.startsWith('pet.'));
      if (pets.length === 1) return [pets[0].key];
    }
  }

  const queryWords = words(query);
  const ranked = active.map(fact => ({
    key: fact.key,
    score: [...words(fact.key + ' ' + fact.value)].filter(word => queryWords.has(word)).length,
  })).filter(fact => fact.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  if (!ranked.length) return [];
  return ranked.filter(fact => fact.score === ranked[0].score).map(fact => fact.key);
}
