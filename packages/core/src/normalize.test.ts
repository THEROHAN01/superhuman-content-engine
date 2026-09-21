import { describe, expect, it } from 'vitest';
import { deriveTitle, normalizeNote, normalizeText } from './normalize.js';
import { NOTE_FIXTURES } from '../../../tests/fixtures/learning-notes.js';

describe('normalizeText', () => {
  it('collapses whitespace and strips list markers without changing words', () => {
    const input = '- TIL:  **SKIP  LOCKED**   works\n\n\n  because   workers skip locked rows.  ';
    expect(normalizeText(input)).toBe(
      'TIL: **SKIP LOCKED** works\n\nbecause workers skip locked rows.',
    );
  });

  it('normalizes smart quotes, dashes and ellipses', () => {
    expect(normalizeText('“don’t” — it…')).toBe('"don\'t" - it...');
  });

  it('removes zero-width characters introduced by copy/paste', () => {
    expect(normalizeText('re​dis')).toBe('redis');
  });

  it('is idempotent', () => {
    for (const fixture of NOTE_FIXTURES) {
      const once = normalizeText(fixture.text);
      expect(normalizeText(once)).toBe(once);
    }
  });

  it('never changes the meaning-bearing words', () => {
    const words = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    for (const fixture of NOTE_FIXTURES) {
      expect(words(normalizeText(fixture.text))).toEqual(words(fixture.text));
    }
  });
});

describe('deriveTitle', () => {
  it('strips the "today I learned that" scaffolding', () => {
    expect(deriveTitle('Today I learned that refresh tokens rotate for a reason.')).toBe(
      'Refresh tokens rotate for a reason',
    );
  });

  it('handles TIL prefixes', () => {
    expect(deriveTitle('TIL: SKIP LOCKED makes a table a queue.')).toBe(
      'SKIP LOCKED makes a table a queue',
    );
  });

  it('caps long titles', () => {
    const title = deriveTitle(`${'a very long sentence that keeps going '.repeat(10)}.`);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('...')).toBe(true);
  });

  it('falls back to the sentence when stripping would leave nothing useful', () => {
    expect(deriveTitle('Redis.')).toBe('Redis');
  });
});

describe('normalizeNote', () => {
  it('keeps an existing title and reports word count', () => {
    const note = normalizeNote(
      'Some note about postgres indexes and their cost.',
      'Existing title',
    );
    expect(note.title).toBe('Existing title');
    expect(note.words).toBeGreaterThan(3);
  });

  it('produces a canonical form suitable for hashing', () => {
    const a = normalizeNote('Refresh-token rotation MATTERS!');
    const b = normalizeNote('  refresh token rotation matters  ');
    expect(a.canonical).toBe(b.canonical);
  });
});
