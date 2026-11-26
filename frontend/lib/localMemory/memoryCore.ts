/** Pure local memory reducer. No network, storage or model dependency. */
export type Fact = { key: string; value: string; revision: number; deleted: boolean };
export type Change = { key: string; value?: string; expectedRevision: number; kind: 'set' | 'forget'; confirmed: boolean };
export function applyChange(facts: readonly Fact[], change: Change): Fact[] {
  if (change.confirmed !== true || (change.kind !== 'set' && change.kind !== 'forget') || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(change.key)) throw Error('Unconfirmed or invalid change');
  const old = facts.find(f => f.key === change.key);
  if ((old?.revision ?? 0) !== change.expectedRevision) throw Error('Stale change');
  const value = change.kind === 'forget' ? '' : typeof change.value === 'string' ? change.value.trim() : undefined;
  if (value === undefined || (change.kind === 'set' && (!value || value.length > 4000))) throw Error('Invalid value');
  if (old && old.value === value && old.deleted === (change.kind === 'forget')) return [...facts];
  if (old?.revision === Number.MAX_SAFE_INTEGER) throw Error('Revision limit reached');
  const next: Fact = {key:change.key,value,revision:(old?.revision ?? 0)+1,deleted:change.kind === 'forget'};
  return [...facts.filter(f=>f.key!==change.key),next];
}
export function selectFacts(facts: readonly Fact[], rankedKeys: readonly string[], maxChars = 2000): Fact[] {
  const result: Fact[] = []; let used = 0;
  const byKey = new Map(facts.filter(f=>!f.deleted).map(f=>[f.key,f]));
  for (const key of new Set(rankedKeys)) { const f=byKey.get(key); if (!f) continue; const size=JSON.stringify(f).length; if (used+size>maxChars) continue; result.push(f); used+=size; }
  return result;
}
