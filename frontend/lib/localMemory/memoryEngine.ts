/** Capability routing only. Native bridges must supply verified capabilities. */
export type Capability = { available: boolean; italian: boolean; onDevice: boolean; ready: boolean };
export type Engine = 'native' | 'downloaded' | 'manual';
export function chooseEngine(native: Capability, downloaded: Capability): Engine {
  const usable = (c: Capability) => c.available && c.italian && c.onDevice && c.ready;
  return usable(native) ? 'native' : usable(downloaded) ? 'downloaded' : 'manual';
}
export interface LocalSemanticEngine {
  readonly onDevice: true;
  propose(input: {utterance: string; context: readonly {key:string;value:string}[]}): Promise<unknown>;
}
export type Proposal = {key:string; value:string; evidence:string};
/** Model output is untrusted; proposals never directly authorize database changes. */
export function validateProposals(raw: unknown, utterance: string): Proposal[] {
  if (!Array.isArray(raw) || raw.length > 8) return [];
  const seen = new Set<string>(); const result: Proposal[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || typeof p.key !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(p.key) || typeof p.value !== 'string' || !p.value.trim() || p.value.length > 4000 || typeof p.evidence !== 'string' || !p.evidence.trim() || !utterance.includes(p.evidence) || seen.has(p.key)) return [];
    seen.add(p.key); result.push({key:p.key,value:p.value.trim(),evidence:p.evidence});
  }
  return result;
}
