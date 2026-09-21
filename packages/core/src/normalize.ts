import { canonicalizeText } from '@sce/utils';

/**
 * Text normalization.
 *
 * Deliberately conservative: it removes capture noise (markdown bullets, smart quotes, repeated
 * whitespace, zero-width characters) and nothing else. Meaning-changing edits belong to the
 * human, not to a pipeline step - the raw text stays untouched in the database either way.
 */
export interface NormalizedNote {
  text: string;
  title: string;
  /** Token count after normalization; used for content-worthiness heuristics and reporting. */
  words: number;
  /** Canonical form used for hashing and near-duplicate comparison. */
  canonical: string;
}

const SMART_QUOTES: Array<[RegExp, string]> = [
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/[–—]/g, '-'],
  [/…/g, '...'],
];

export const normalizeText = (raw: string): string => {
  let text = raw.normalize('NFKC');
  for (const [pattern, replacement] of SMART_QUOTES) text = text.replace(pattern, replacement);

  const lines = text
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width characters from copy/paste
    .replace(/\r\n?/g, '\n')
    .split('\n');

  // Indentation is capture noise in prose but meaningful inside fenced code, so fences are kept
  // verbatim while prose lines are dedented, de-bulleted and de-double-spaced.
  let inFence = false;
  const cleaned = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line.trim();
    }
    if (inFence) return line.replace(/\s+$/, '');
    return line
      .replace(/^\s+/, '')
      .replace(/^[-*\u2022]\s+/, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+$/, '');
  });

  return cleaned
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/**
 * Derives a title when the capture had none: the first sentence, with the "Today I learned that"
 * scaffolding removed, capped at 120 characters.
 */
export const deriveTitle = (text: string): string => {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? text;
  const firstSentence = firstLine.split(/(?<=[.!?])\s+/)[0] ?? firstLine;
  const stripped = firstSentence
    .replace(/^(today\s+)?i\s+(learned|found out|discovered|realised|realized)\s+(that\s+)?/i, '')
    .replace(/^(til|note|learning)\s*[:\-–]\s*/i, '')
    .trim();

  const base = (stripped.length >= 8 ? stripped : firstSentence.trim()).replace(/[.]+$/, '');
  // Truncate after removing the sentence's full stop, so the ellipsis marks truncation only.
  const capped = base.length > 120 ? `${base.slice(0, 117).trimEnd()}...` : base;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
};

export const normalizeNote = (raw: string, existingTitle?: string | null): NormalizedNote => {
  const text = normalizeText(raw);
  const canonical = canonicalizeText(text);
  return {
    text,
    title: existingTitle?.trim() || deriveTitle(text),
    words: canonical === '' ? 0 : canonical.split(' ').length,
    canonical,
  };
};
