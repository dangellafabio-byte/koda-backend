import { Capability, LocalSemanticEngine, validateProposals } from './memoryEngine';
export interface AppleBridge {
  capabilities(): Promise<Capability>;
  propose(utterance: string, contextJSON: string): Promise<string>;
}
export function appleEngine(bridge: AppleBridge): LocalSemanticEngine {
  return { onDevice: true, async propose({utterance, context}) {
    try {
    const c = await bridge.capabilities();
    if (c.available !== true || c.italian !== true || c.onDevice !== true || c.ready !== true) return [];
    const json = JSON.stringify(context);
    if (utterance.length > 2000 || json.length > 3000) return [];
    return validateProposals(JSON.parse(await bridge.propose(utterance,json)),utterance); }
    catch { return []; }
  }};
}

/** Keep supported Italian facts available even when Foundation Models is unavailable. */
export function conversationEngine(local: LocalSemanticEngine, bridge: AppleBridge | null): LocalSemanticEngine {
  if (!bridge) return local;
  const apple = appleEngine(bridge);
  return {
    onDevice: true,
    async propose(input) {
      const proposals = validateProposals(await local.propose(input), input.utterance);
      return proposals.length ? proposals : apple.propose(input);
    },
  };
}
