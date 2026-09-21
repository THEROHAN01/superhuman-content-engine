import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, InvalidUrlError, tryCanonicalizeUrl } from './url.js';

describe('canonicalizeUrl', () => {
  it('collapses the variations that point at the same document', () => {
    const forms = [
      'http://www.postgresql.org/docs/16/sql-select.html',
      'https://postgresql.org/docs/16/sql-select.html',
      'https://www.postgresql.org/docs/16/sql-select.html#notes',
      'https://www.postgresql.org/docs/16/sql-select.html?utm_source=twitter&utm_campaign=x',
    ];
    const canonical = forms.map((f) => canonicalizeUrl(f).canonical);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('https://postgresql.org/docs/16/sql-select.html');
  });

  it('keeps meaningful query parameters and sorts them', () => {
    expect(canonicalizeUrl('https://example.com/s?b=2&a=1&utm_source=x').canonical).toBe(
      'https://example.com/s?a=1&b=2',
    );
  });

  it('strips a trailing slash except at the root', () => {
    expect(canonicalizeUrl('https://example.com/docs/').canonical).toBe('https://example.com/docs');
    expect(canonicalizeUrl('https://example.com/').canonical).toBe('https://example.com/');
  });

  it('rejects non-http protocols and credential-bearing urls', () => {
    expect(() => canonicalizeUrl('file:///etc/passwd')).toThrow(InvalidUrlError);
    expect(() => canonicalizeUrl('https://user:pw@example.com')).toThrow(/credentials/);
  });

  it('rejects unparseable input rather than repairing it', () => {
    expect(() => canonicalizeUrl('postgres docs page')).toThrow(InvalidUrlError);
    expect(tryCanonicalizeUrl('postgres docs page')).toBeNull();
  });
});
