/**
 * Phrases that make writing sound generated rather than lived.
 *
 * Kept separate from the voice rules because two different things consume it: the generator
 * prompts (as an instruction) and the quality gate (as a check). A phrase only belongs here if it
 * is a reliable tell - banning ordinary words would make the gate useless.
 */
export const BANNED_PHRASES = [
  "in today's fast-paced world",
  'in the ever-evolving landscape',
  'game changer',
  'game-changer',
  'unlock the power',
  'unlock the full potential',
  'dive deep',
  "let's dive in",
  'in this thread',
  'a thread',
  'mind-blowing',
  'revolutionary',
  'the secret to',
  "you won't believe",
  'as an ai',
  'as a language model',
  'leverage synergies',
  'supercharge',
  '10x your',
  'this changed everything',
  'hot take',
  'buckle up',
  'here is the kicker',
  "here's the kicker",
  'needle-moving',
  'paradigm shift',
] as const;

export type BannedPhrase = (typeof BANNED_PHRASES)[number];

/** Normalizes curly quotes so a phrase is caught however the model typed it. */
const normalize = (text: string): string =>
  text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');

export const findBannedPhrases = (text: string): BannedPhrase[] => {
  const haystack = normalize(text);
  return BANNED_PHRASES.filter((phrase) => haystack.includes(normalize(phrase)));
};

export const BANNED_PHRASE_RULE = `Never use these phrases or close variants:\n${BANNED_PHRASES.map(
  (phrase) => `- ${phrase}`,
).join('\n')}`;
