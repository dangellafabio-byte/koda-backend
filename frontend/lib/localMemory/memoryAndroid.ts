import { Capability, LocalSemanticEngine, validateProposals } from './memoryEngine';
/** Native implementation must attest offline inference, Italian support and readiness. */
export interface AndroidBridge {
  capabilities(): Promise<Capability>;
  propose(utterance: string, contextJSON: string): Promise<string>;
}
export function androidEngine(bridge: AndroidBridge): LocalSemanticEngine {
  return {onDevice:true, async propose({utterance,context}) {
    try {
      if (!utterance.trim() || utterance.length > 2000) return [];
      const json=JSON.stringify(context);
      if (json.length > 3000) return [];
      const c=await bridge.capabilities();
      if (c.available !== true || c.italian !== true || c.onDevice !== true || c.ready !== true) return [];
      const raw=await bridge.propose(utterance,json);
      if (typeof raw !== 'string' || raw.length > 16000) return [];
      return validateProposals(JSON.parse(raw),utterance);
    } catch { return []; }
  }};
}
