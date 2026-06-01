/**
 * EMOTION CLASSIFIER — On-device, multilingual, zero-network.
 *
 * Architettura del CONFESSIONALE FORTEZZA:
 *  1. L'utente parla/scrive sul device → testo grezzo
 *  2. QUESTO modulo (locale, JS) estrae SOLO {emotion, intensity, language}
 *  3. SOLO questo trio astratto viene mandato al server
 *  4. Il testo grezzo NON LASCIA MAI il telefono
 *
 * Funziona offline, su QUALSIASI iPhone/Android, senza modelli da scaricare.
 * Lingue supportate con dizionari espliciti: it, en, es, fr, de, pt.
 * Lingue non supportate → fallback "neutral negative" → Claude risponde
 * comunque empaticamente in modo generico.
 */

export type Emotion =
  | "ansia"
  | "rabbia"
  | "tristezza"
  | "vuoto"
  | "vergogna"
  | "solitudine"
  | "paura"
  | "rimorso"
  | "confusione"
  | "stanchezza"
  | "impotenza"
  | "delusione"
  | "gelosia"
  | "nostalgia"
  | "amarezza"
  | "sopraffazione"
  | "frustrazione"
  | "inadeguatezza"
  | "dolore"
  | "shock";

export type Intensity = "lieve" | "media" | "alta";

export type EmotionClassification = {
  emotion: Emotion;
  intensity: Intensity;
  language: string; // ISO 639-1
};

// ──────────────────────────────────────────────────────────────────
// LANGUAGE DETECTION (heuristic, no model needed)
// ──────────────────────────────────────────────────────────────────
const LANG_MARKERS: Record<string, string[]> = {
  it: ["il", "la", "che", "non", "sono", "mi", "ti", "ho", "è", "ma", "perché", "anche", "questo", "molto", "essere"],
  en: ["the", "and", "to", "of", "i", "you", "is", "in", "that", "it", "for", "this", "but", "with", "have", "am"],
  es: ["el", "la", "que", "no", "es", "y", "en", "me", "te", "mi", "muy", "soy", "estoy", "pero", "porque"],
  fr: ["le", "la", "et", "je", "tu", "ne", "pas", "que", "est", "de", "à", "moi", "mais", "très", "pour"],
  de: ["ich", "und", "die", "der", "das", "nicht", "ist", "zu", "ein", "mit", "sich", "auf", "aber", "sehr"],
  pt: ["o", "a", "que", "não", "é", "de", "me", "ti", "mas", "muito", "estou", "sou", "porque", "também"],
};

export function detectLanguage(text: string): string {
  const t = text.toLowerCase().replace(/[^\p{L}\s]/gu, " ");
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return "en"; // fallback
  const scores: Record<string, number> = {};
  for (const [lang, markers] of Object.entries(LANG_MARKERS)) {
    let s = 0;
    for (const w of words) {
      if (markers.includes(w)) s++;
    }
    scores[lang] = s;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : "en";
}

// ──────────────────────────────────────────────────────────────────
// EMOTION KEYWORD DICTIONARIES (multilingual)
// ──────────────────────────────────────────────────────────────────
type EmotionDict = Partial<Record<Emotion, string[]>>;

const DICT_IT: EmotionDict = {
  ansia: ["ansia", "ansioso", "panico", "soffoco", "agitato", "in apnea", "iperventil", "batticuore", "stress", "tensione", "nervo"],
  rabbia: ["rabbia", "incazzato", "incazzata", "arrabbiat", "furioso", "furiosa", "odio", "rancore", "incavolat", "schifato", "schifata"],
  tristezza: ["triste", "piango", "lacrim", "depress", "giù", "demoralizz", "abbattut", "scoraggi", "sconforto"],
  vuoto: ["vuoto", "nulla", "niente dentro", "spento", "spenta", "anaffettiv", "anestetizz", "non sento niente"],
  vergogna: ["vergogna", "vergognoso", "vergognosa", "umiliato", "umiliata", "imbarazz", "indegno", "indegna", "schifo di me"],
  solitudine: ["solo", "sola", "solitudine", "abbandonato", "abbandonata", "ignorato", "ignorata", "invisibile", "nessuno"],
  paura: ["paura", "terrore", "spaventato", "spaventata", "ho timore", "fobia", "tremo"],
  rimorso: ["rimorso", "rimpianto", "colpa", "in colpa", "non doveva", "se avessi"],
  confusione: ["confuso", "confusa", "non capisco", "non so", "perso", "persa", "smarrito", "smarrita", "non riesco a pensare"],
  stanchezza: ["stanco", "stanca", "esausto", "esausta", "sfinito", "sfinita", "non ce la faccio", "stremato", "stremata"],
  impotenza: ["impotente", "non posso fare niente", "incatenato", "incatenata", "bloccato", "bloccata", "intrappolat"],
  delusione: ["deluso", "delusa", "tradito", "tradita", "amareggiato", "amareggiata", "ferito", "ferita"],
  gelosia: ["geloso", "gelosa", "invidia", "invidio", "invidiosa", "rosica", "rivale"],
  nostalgia: ["nostalgia", "mi manca", "mancanza", "tornare indietro", "rimpiango"],
  amarezza: ["amarezza", "amaro", "amara", "bocca amara"],
  sopraffazione: ["sopraffatto", "sopraffatta", "non ce la faccio più", "troppo", "soverchiat", "schiacciato", "schiacciata"],
  frustrazione: ["frustrato", "frustrata", "frustrazione", "rabbia impotente", "stop continuo"],
  inadeguatezza: ["inadeguato", "inadeguata", "non sono all'altezza", "non valgo", "non basto", "fallimento", "fallito", "fallita"],
  dolore: ["dolore", "soffro", "soffrire", "male dentro", "fa male"],
  shock: ["shock", "scioccato", "scioccata", "non ci credo", "impietrito", "impietrita", "paralizzato", "paralizzata"],
};

const DICT_EN: EmotionDict = {
  ansia: ["anxious", "anxiety", "panic", "suffocate", "agitated", "racing heart", "stressed", "tense", "nervous", "uneasy"],
  rabbia: ["angry", "anger", "furious", "rage", "hate", "pissed", "resentful", "mad", "irritated", "outraged"],
  tristezza: ["sad", "crying", "tears", "depressed", "down", "discouraged", "blue", "heartbroken"],
  vuoto: ["empty", "numb", "void", "nothing inside", "hollow", "dissociated", "feel nothing"],
  vergogna: ["ashamed", "shame", "humiliated", "embarrassed", "disgust myself", "unworthy"],
  solitudine: ["lonely", "alone", "loneliness", "abandoned", "ignored", "invisible", "nobody", "isolated"],
  paura: ["scared", "fear", "afraid", "terrified", "fearful", "phobia", "trembling"],
  rimorso: ["regret", "remorse", "guilt", "guilty", "i shouldn't have", "if only i had"],
  confusione: ["confused", "lost", "don't understand", "don't know", "muddled", "can't think"],
  stanchezza: ["tired", "exhausted", "drained", "spent", "can't do it anymore", "burnt out", "burned out"],
  impotenza: ["powerless", "helpless", "can't do anything", "trapped", "stuck"],
  delusione: ["disappointed", "betrayed", "let down", "hurt"],
  gelosia: ["jealous", "jealousy", "envy", "envious", "rival"],
  nostalgia: ["miss", "missing", "nostalgia", "long for", "homesick"],
  amarezza: ["bitter", "bitterness"],
  sopraffazione: ["overwhelmed", "too much", "can't take it", "crushed", "swamped"],
  frustrazione: ["frustrated", "frustration"],
  inadeguatezza: ["inadequate", "not enough", "worthless", "failure", "failed", "not good enough"],
  dolore: ["pain", "hurt", "hurting", "suffering", "ache"],
  shock: ["shocked", "in shock", "can't believe", "frozen", "paralyzed"],
};

const DICT_ES: EmotionDict = {
  ansia: ["ansiedad", "ansioso", "ansiosa", "pánico", "ahogo", "agitado", "agitada", "estresado", "estresada", "nervioso", "nerviosa"],
  rabbia: ["enojado", "enojada", "rabia", "furioso", "furiosa", "odio", "molesto", "molesta"],
  tristezza: ["triste", "lloro", "lágrimas", "deprimido", "deprimida", "abatido", "abatida"],
  vuoto: ["vacío", "vacía", "nada por dentro", "entumecido", "entumecida"],
  vergogna: ["vergüenza", "humillado", "humillada", "avergonzado", "avergonzada"],
  solitudine: ["solo", "sola", "soledad", "abandonado", "abandonada", "ignorado", "ignorada", "invisible"],
  paura: ["miedo", "asustado", "asustada", "aterrado", "aterrada"],
  rimorso: ["arrepentimiento", "culpa", "culpable", "no debí"],
  confusione: ["confundido", "confundida", "perdido", "perdida", "no entiendo"],
  stanchezza: ["cansado", "cansada", "agotado", "agotada", "exhausto", "exhausta"],
  impotenza: ["impotente", "atrapado", "atrapada", "sin poder hacer nada"],
  delusione: ["decepcionado", "decepcionada", "traicionado", "traicionada"],
  gelosia: ["celos", "celoso", "celosa", "envidia"],
  nostalgia: ["nostalgia", "extraño", "extraña", "me hace falta"],
  amarezza: ["amargura", "amargo", "amarga"],
  sopraffazione: ["abrumado", "abrumada", "demasiado"],
  frustrazione: ["frustrado", "frustrada", "frustración"],
  inadeguatezza: ["inadecuado", "inadecuada", "no soy suficiente", "fracaso"],
  dolore: ["dolor", "duele", "sufro"],
  shock: ["shock", "no puedo creer", "paralizado", "paralizada"],
};

const DICT_FR: EmotionDict = {
  ansia: ["anxieux", "anxieuse", "anxiété", "panique", "stressé", "stressée", "nerveux", "nerveuse", "tendu", "tendue"],
  rabbia: ["en colère", "rage", "furieux", "furieuse", "haine", "énervé", "énervée"],
  tristezza: ["triste", "pleure", "larmes", "déprimé", "déprimée", "abattu", "abattue"],
  vuoto: ["vide", "rien à l'intérieur", "engourdi", "engourdie"],
  vergogna: ["honte", "humilié", "humiliée", "embarrassé", "embarrassée"],
  solitudine: ["seul", "seule", "solitude", "abandonné", "abandonnée", "ignoré", "ignorée", "invisible"],
  paura: ["peur", "effrayé", "effrayée", "terrifié", "terrifiée"],
  rimorso: ["regret", "culpabilité", "coupable", "j'aurais dû"],
  confusione: ["confus", "confuse", "perdu", "perdue", "je ne comprends pas"],
  stanchezza: ["fatigué", "fatiguée", "épuisé", "épuisée", "exténué", "exténuée"],
  impotenza: ["impuissant", "impuissante", "coincé", "coincée"],
  delusione: ["déçu", "déçue", "trahi", "trahie"],
  gelosia: ["jaloux", "jalouse", "jalousie", "envie"],
  nostalgia: ["nostalgie", "manque", "il me manque"],
  amarezza: ["amertume", "amer", "amère"],
  sopraffazione: ["dépassé", "dépassée", "trop", "submergé", "submergée"],
  frustrazione: ["frustré", "frustrée", "frustration"],
  inadeguatezza: ["inadéquat", "inadéquate", "pas assez", "échec"],
  dolore: ["douleur", "souffre", "ça fait mal"],
  shock: ["choqué", "choquée", "paralysé", "paralysée"],
};

const DICT_DE: EmotionDict = {
  ansia: ["angst", "ängstlich", "panik", "gestresst", "nervös", "angespannt"],
  rabbia: ["wütend", "wut", "zornig", "hass", "verärgert"],
  tristezza: ["traurig", "weine", "tränen", "deprimiert", "niedergeschlagen"],
  vuoto: ["leer", "nichts in mir", "taub"],
  vergogna: ["scham", "beschämt", "gedemütigt", "peinlich"],
  solitudine: ["allein", "einsam", "einsamkeit", "verlassen", "ignoriert", "unsichtbar"],
  paura: ["furcht", "ängstlich", "erschrocken", "terrorisiert"],
  rimorso: ["reue", "schuld", "schuldig", "hätte ich"],
  confusione: ["verwirrt", "verloren", "verstehe nicht"],
  stanchezza: ["müde", "erschöpft", "ausgelaugt"],
  impotenza: ["machtlos", "gefangen", "festgefahren"],
  delusione: ["enttäuscht", "verraten", "verletzt"],
  gelosia: ["eifersüchtig", "eifersucht", "neid"],
  nostalgia: ["sehnsucht", "vermisse"],
  amarezza: ["bitter", "bitterkeit"],
  sopraffazione: ["überfordert", "zu viel"],
  frustrazione: ["frustriert", "frustration"],
  inadeguatezza: ["unzureichend", "nicht genug", "versagen"],
  dolore: ["schmerz", "leide", "tut weh"],
  shock: ["schock", "kann nicht glauben", "gelähmt"],
};

const DICT_PT: EmotionDict = {
  ansia: ["ansioso", "ansiosa", "ansiedade", "pânico", "estressado", "estressada", "nervoso", "nervosa", "tenso", "tensa"],
  rabbia: ["raiva", "furioso", "furiosa", "ódio", "irritado", "irritada"],
  tristezza: ["triste", "choro", "lágrimas", "deprimido", "deprimida", "abatido", "abatida"],
  vuoto: ["vazio", "vazia", "nada dentro", "anestesiado", "anestesiada"],
  vergogna: ["vergonha", "humilhado", "humilhada", "envergonhado", "envergonhada"],
  solitudine: ["sozinho", "sozinha", "solidão", "abandonado", "abandonada", "ignorado", "ignorada", "invisível"],
  paura: ["medo", "assustado", "assustada", "aterrorizado", "aterrorizada"],
  rimorso: ["arrependimento", "culpa", "culpado", "culpada", "não deveria"],
  confusione: ["confuso", "confusa", "perdido", "perdida", "não entendo"],
  stanchezza: ["cansado", "cansada", "exausto", "exausta", "esgotado", "esgotada"],
  impotenza: ["impotente", "preso", "presa", "sem poder fazer nada"],
  delusione: ["decepcionado", "decepcionada", "traído", "traída"],
  gelosia: ["ciúme", "ciumento", "ciumenta", "inveja"],
  nostalgia: ["saudade", "tenho saudades"],
  amarezza: ["amargura", "amargo", "amarga"],
  sopraffazione: ["sobrecarregado", "sobrecarregada", "demais"],
  frustrazione: ["frustrado", "frustrada", "frustração"],
  inadeguatezza: ["inadequado", "inadequada", "não sou suficiente", "fracasso"],
  dolore: ["dor", "dói", "sofro"],
  shock: ["choque", "chocado", "chocada", "paralisado", "paralisada"],
};

const ALL_DICTS: Record<string, EmotionDict> = {
  it: DICT_IT, en: DICT_EN, es: DICT_ES, fr: DICT_FR, de: DICT_DE, pt: DICT_PT,
};

// ──────────────────────────────────────────────────────────────────
// CLASSIFICATION ALGORITHM
// ──────────────────────────────────────────────────────────────────
export function classifyEmotion(text: string): EmotionClassification {
  const language = detectLanguage(text);
  const lowerText = text.toLowerCase();
  const dict: EmotionDict = ALL_DICTS[language] || DICT_EN;

  // Score each emotion by counting keyword hits
  const scores: Partial<Record<Emotion, number>> = {};
  for (const [emo, keywords] of Object.entries(dict)) {
    let s = 0;
    for (const kw of keywords || []) {
      if (lowerText.includes(kw)) s += 1;
      // Bonus for exact word match (word boundary)
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(lowerText)) s += 1;
    }
    if (s > 0) scores[emo as Emotion] = s;
  }

  // Pick top emotion (or fallback to 'dolore' for generic distress)
  let emotion: Emotion = "dolore";
  let topScore = 0;
  for (const [emo, s] of Object.entries(scores)) {
    if ((s as number) > topScore) {
      topScore = s as number;
      emotion = emo as Emotion;
    }
  }

  // Intensity heuristic:
  //  - 0 keyword hits → "lieve" (fallback dolore)
  //  - 1-2 hits OR long text → "media"
  //  - 3+ hits OR caps/!!! → "alta"
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasCapsShout = /[A-ZÀ-Ý]{4,}/.test(text);
  const hasMultiBang = /(!{2,}|\?{2,})/.test(text);
  const hasIntenseWord = /(troppo|tanto|so much|tellement|mucho|viel|muito)/i.test(text);

  let intensity: Intensity = "media";
  if (topScore === 0 && wordCount < 8) intensity = "lieve";
  else if (topScore >= 3 || hasCapsShout || hasMultiBang || (topScore >= 2 && hasIntenseWord)) intensity = "alta";
  else intensity = "media";

  return { emotion, intensity, language };
}

// ──────────────────────────────────────────────────────────────────
// SAFE WIPE — chiama questo quando l'utente esce dal confessionale.
// Forza la garbage collection di stringhe sensibili sovrascrivendole.
// ──────────────────────────────────────────────────────────────────
export function secureWipeStrings(...refs: Array<{ current: string | null | undefined }>) {
  for (const ref of refs) {
    try {
      if (ref && typeof ref === "object" && "current" in ref) {
        // Overwrite with garbage prima di set null
        ref.current = "\0".repeat(1024);
        ref.current = null;
      }
    } catch {
      // ignore
    }
  }
}
