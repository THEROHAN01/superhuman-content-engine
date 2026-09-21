import { contentHash } from '@sce/utils';

/**
 * Duplicate detection.
 *
 * Exact duplicates are caught by the database's unique content hash. This module adds *near*
 * duplicate detection for notes that say the same thing with different words, using Jaccard
 * similarity over content-word shingles - deterministic, explainable, and cheap enough to run on
 * every capture.
 *
 * A near duplicate is never deleted: the new event is linked to the original, keeping provenance.
 */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'that',
  'this',
  'these',
  'those',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'about',
  'into',
  'from',
  'it',
  'its',
  'as',
  'so',
  'than',
  'too',
  'very',
  'can',
  'will',
  'just',
  'i',
  'you',
  'we',
  'they',
  'my',
  'our',
  'their',
  'today',
  'learned',
  'learn',
  'note',
]);

export const contentTokens = (canonical: string): string[] =>
  canonical.split(' ').filter((token) => token.length > 2 && !STOP_WORDS.has(token));

/** Overlapping word pairs: order-sensitive enough to distinguish rearranged sentences. */
export const shingles = (tokens: string[], size = 2): Set<string> => {
  if (tokens.length < size) return new Set(tokens);
  const result = new Set<string>();
  for (let i = 0; i <= tokens.length - size; i++) {
    result.add(tokens.slice(i, i + size).join(' '));
  }
  return result;
};

export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
};

/** Overlap coefficient: how much of the smaller note is contained in the larger one. */
export const containment = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / Math.min(a.size, b.size);
};

/**
 * Blended similarity over content words, containment and word bigrams.
 *
 * Measured on the fixtures (`dedupe.test.ts` asserts the separation):
 *   two wordings of the same learning   0.31 - 0.56
 *   different learnings, any topic      0.00 - 0.07
 *
 * Word-level Jaccard alone misses restatements that add or drop clauses; containment catches
 * those but over-fires on a short note quoted inside a long one, so it carries less weight and
 * needs both notes to be substantial (below). Bigrams add a little word-order evidence.
 */
export const similarity = (canonicalA: string, canonicalB: string): number => {
  const tokensA = contentTokens(canonicalA);
  const tokensB = contentTokens(canonicalB);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  const words = jaccard(setA, setB);
  const bigrams = jaccard(shingles(tokensA), shingles(tokensB));
  // Containment is unreliable when one side is tiny (a 4-word note is "contained" in everything).
  const substantial = setA.size >= 8 && setB.size >= 8;
  const overlap = substantial ? containment(setA, setB) : words;

  return 0.45 * words + 0.35 * overlap + 0.2 * bigrams;
};

/**
 * Above this, two notes are treated as the same learning captured twice.
 *
 * 0.18 sits about 2.5x above the highest score any pair of genuinely different fixtures reaches
 * (0.07) and well below the lowest score a real restatement reaches (0.31), so both error modes
 * have margin. The margin itself is asserted by a test, so retuning cannot silently erode it.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.18;

export interface DuplicateCandidate {
  id: string;
  canonical: string;
}

export interface DuplicateVerdict {
  duplicate: boolean;
  of: string | null;
  score: number;
  reason: 'exact_hash' | 'near_duplicate' | 'distinct';
}

export const findDuplicate = (
  canonical: string,
  candidates: readonly DuplicateCandidate[],
  threshold = NEAR_DUPLICATE_THRESHOLD,
): DuplicateVerdict => {
  const hash = contentHash(canonical);
  for (const candidate of candidates) {
    if (contentHash(candidate.canonical) === hash) {
      return { duplicate: true, of: candidate.id, score: 1, reason: 'exact_hash' };
    }
  }

  let best: { id: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = similarity(canonical, candidate.canonical);
    if (!best || score > best.score) best = { id: candidate.id, score };
  }

  if (best && best.score >= threshold) {
    return { duplicate: true, of: best.id, score: best.score, reason: 'near_duplicate' };
  }
  return { duplicate: false, of: null, score: best?.score ?? 0, reason: 'distinct' };
};
