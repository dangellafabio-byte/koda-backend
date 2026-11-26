import type { LocalSemanticEngine } from './memoryEngine';

const WORD = String.raw`[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*`;
const LABEL = `${WORD}(?: ${WORD}){0,3}`;
const patterns = [
  {key: 'home.city', pattern: new RegExp(`^(?:ora )?(?:abito|vivo) (?:a|ad|in) (${LABEL})$`, 'iu')},
  {key: 'pet.name', pattern: new RegExp(`^il mio (?:gatto|cane) si chiama (${LABEL})$|^la mia (?:gatta|cagnolina) si chiama (${LABEL})$`, 'iu')},
  {key: 'hobby.music', pattern: new RegExp(`^suono (?:la|il|l['’]) ?(${LABEL})$`, 'iu')},
];
const uncertain = /\b(?:forse|potrei|sembra|penso|ipotizziamo|tipo|non|test|prova|finto|finta|esempio)\b/iu;

/**
 * A conservative Italian baseline shared by iOS and Android. It proposes
 * canonical facts from a few explicit declarations and abstains otherwise.
 */
export const localItalianEngine: LocalSemanticEngine = {
  onDevice: true,
  async propose({utterance}) {
    const evidence = utterance.trim();
    if (!evidence || evidence.length > 240 || /[?¿“”«»"\r\n]/u.test(evidence) || uncertain.test(evidence)) return [];
    const declaration = evidence.replace(/[.!]$/u, '').replace(/^ricorda(?:ti)? che /iu, '');
    for (const {key, pattern} of patterns) {
      const match = pattern.exec(declaration);
      const value = match?.[1] ?? match?.[2];
      if (value && !/\b(?:che|con|quando|mentre|perché|ma|sono)\b/iu.test(value)) return [{key, value, evidence}];
    }
    return [];
  },
};
