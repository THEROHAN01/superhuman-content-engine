import { describe, expect, it } from 'vitest';
import {
  assessSignificance,
  parseGithubEvent,
  signGithubPayload,
  toLearningText,
  verifyGithubSignature,
} from './index.js';
import { GITHUB_FIXTURES } from '../../../../tests/fixtures/github-events.js';

const SECRET = 'a-shared-webhook-secret';

describe('signature verification', () => {
  const body = JSON.stringify({ hello: 'world' });

  it('accepts a signature over the exact bytes', () => {
    expect(verifyGithubSignature(body, signGithubPayload(body, SECRET), SECRET)).toEqual({
      valid: true,
    });
  });

  it('rejects a signature over different bytes, including whitespace changes', () => {
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyGithubSignature(reserialized, signGithubPayload(body, SECRET), SECRET).valid).toBe(
      false,
    );
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyGithubSignature(body, signGithubPayload(body, 'other'), SECRET)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('reports missing and malformed headers distinctly', () => {
    expect(verifyGithubSignature(body, undefined, SECRET).reason).toBe('missing');
    expect(verifyGithubSignature(body, 'sha256=xyz', SECRET).reason).toBe('malformed');
    expect(verifyGithubSignature(body, 'sha1=' + 'a'.repeat(40), SECRET).reason).toBe('malformed');
  });

  it('works on a Buffer body, which is what the server actually holds', () => {
    const buffer = Buffer.from(body, 'utf8');
    expect(verifyGithubSignature(buffer, signGithubPayload(buffer, SECRET), SECRET).valid).toBe(
      true,
    );
  });
});

describe('event parsing', () => {
  it('extracts the fields the pipeline needs from a merged pull request', () => {
    const fixture = GITHUB_FIXTURES.find((f) => f.name === 'merged PR with a real explanation')!;
    const parsed = parseGithubEvent('pull_request', fixture.payload);

    expect(parsed.matched).toBe(true);
    if (!parsed.matched) return;
    expect(parsed.event).toMatchObject({
      kind: 'pull_request_merged',
      repository: 'therohan01/superhuman-content-engine',
      ref: 'main',
      sha: 'abc123',
      author: 'therohan01',
    });
    expect(parsed.event.externalId).toBe('pr:100');
    expect(parsed.event.stats.changedFiles).toBe(6);
  });

  it('ignores event types it does not model', () => {
    const parsed = parseGithubEvent('issue_comment', { action: 'created' });
    expect(parsed.matched).toBe(false);
    if (parsed.matched) return;
    expect(parsed.reason).toContain('not handled');
  });

  it('gives the same external id for the same pull request', () => {
    const fixture = GITHUB_FIXTURES.find((f) => f.name === 'merged PR with a real explanation')!;
    const a = parseGithubEvent('pull_request', fixture.payload);
    const b = parseGithubEvent('pull_request', fixture.payload);
    expect(a.matched && b.matched && a.event.externalId === b.event.externalId).toBe(true);
  });
});

describe('significance', () => {
  for (const fixture of GITHUB_FIXTURES) {
    const parsed = parseGithubEvent(fixture.eventType, fixture.payload);
    if (!parsed.matched) continue;

    it(`${fixture.name} -> ${fixture.expect.status}`, () => {
      const verdict = assessSignificance(parsed.event);
      expect(verdict.significant, verdict.reason).toBe(fixture.expect.status === 'captured');
      expect(verdict.reason.length).toBeGreaterThan(10);
      expect(verdict.score).toBeGreaterThanOrEqual(0);
      expect(verdict.score).toBeLessThanOrEqual(1);
    });
  }

  it('always explains itself', () => {
    for (const fixture of GITHUB_FIXTURES) {
      const parsed = parseGithubEvent(fixture.eventType, fixture.payload);
      if (!parsed.matched) continue;
      expect(assessSignificance(parsed.event).reason).toBeTruthy();
    }
  });
});

describe('learning text', () => {
  it('quotes GitHub verbatim and always carries the source link', () => {
    const fixture = GITHUB_FIXTURES.find((f) => f.name === 'merged PR with a real explanation')!;
    const parsed = parseGithubEvent('pull_request', fixture.payload);
    if (!parsed.matched) return;

    const text = toLearningText(parsed.event);
    expect(text).toContain(parsed.event.title);
    expect(text).toContain(parsed.event.body.split('\n')[0]!);
    expect(text).toContain(parsed.event.url);
    expect(text).toContain('Changed 6 file(s)');
  });
});
