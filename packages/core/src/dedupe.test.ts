import { describe, expect, it } from 'vitest';
import { canonicalizeText } from '@sce/utils';
import { findDuplicate, jaccard, NEAR_DUPLICATE_THRESHOLD, similarity } from './dedupe.js';
import {
  DISTINCT_SAME_TOPIC,
  NEAR_DUPLICATE_PAIR,
  NOTE_FIXTURES,
} from '../../../tests/fixtures/learning-notes.js';

const canon = (s: string) => canonicalizeText(s);

describe('similarity', () => {
  it('scores a restatement of the same learning above the duplicate threshold', () => {
    const score = similarity(
      canon(NEAR_DUPLICATE_PAIR.original),
      canon(NEAR_DUPLICATE_PAIR.restated),
    );
    expect(score).toBeGreaterThan(NEAR_DUPLICATE_THRESHOLD);
  });

  it('scores a different learning about the same topic well below the threshold', () => {
    const score = similarity(canon(NEAR_DUPLICATE_PAIR.original), canon(DISTINCT_SAME_TOPIC));
    expect(score).toBeLessThan(NEAR_DUPLICATE_THRESHOLD / 2);
  });

  it('keeps a wide margin between restatements and distinct notes', () => {
    // Guards the tuning: any change that narrows this gap breaks the build rather than quietly
    // making deduplication trigger-happy or useless.
    const restatement = similarity(
      canon(NEAR_DUPLICATE_PAIR.original),
      canon(NEAR_DUPLICATE_PAIR.restated),
    );
    const distinctScores = NOTE_FIXTURES.flatMap((a, i) =>
      NOTE_FIXTURES.slice(i + 1).map((b) => similarity(canon(a.text), canon(b.text))),
    );
    expect(Math.max(...distinctScores)).toBeLessThan(restatement / 3);
  });

  it('is symmetric', () => {
    const a = canon(NOTE_FIXTURES[0]!.text);
    const b = canon(NOTE_FIXTURES[1]!.text);
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
  });

  it('treats identical text as identical', () => {
    const a = canon(NOTE_FIXTURES[2]!.text);
    expect(similarity(a, a)).toBe(1);
  });
});

describe('jaccard', () => {
  it('handles empty sets without dividing by zero', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });
});

describe('findDuplicate', () => {
  const candidates = NOTE_FIXTURES.slice(0, 3).map((fixture, index) => ({
    id: `le_fixture_${index}`,
    canonical: canon(fixture.text),
  }));

  it('detects an exact duplicate by hash', () => {
    const verdict = findDuplicate(canon(NOTE_FIXTURES[1]!.text), candidates);
    expect(verdict).toMatchObject({
      duplicate: true,
      of: 'le_fixture_1',
      reason: 'exact_hash',
      score: 1,
    });
  });

  it('detects a near duplicate and names the original', () => {
    const verdict = findDuplicate(canon(NEAR_DUPLICATE_PAIR.restated), [
      { id: 'le_original', canonical: canon(NEAR_DUPLICATE_PAIR.original) },
    ]);
    expect(verdict.duplicate).toBe(true);
    expect(verdict.of).toBe('le_original');
    expect(verdict.reason).toBe('near_duplicate');
  });

  it('leaves distinct notes alone', () => {
    const verdict = findDuplicate(canon(DISTINCT_SAME_TOPIC), candidates);
    expect(verdict).toMatchObject({ duplicate: false, of: null, reason: 'distinct' });
  });

  it('never flags a duplicate when there is nothing to compare against', () => {
    expect(findDuplicate(canon(NOTE_FIXTURES[0]!.text), [])).toMatchObject({ duplicate: false });
  });

  it('respects a custom threshold', () => {
    const strict = findDuplicate(
      canon(NEAR_DUPLICATE_PAIR.restated),
      [{ id: 'le_original', canonical: canon(NEAR_DUPLICATE_PAIR.original) }],
      0.99,
    );
    expect(strict.duplicate).toBe(false);
  });
});
