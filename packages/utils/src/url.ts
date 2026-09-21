/**
 * URL canonicalization for evidence deduplication.
 *
 * Two links to the same document must collapse to one source, and tracking parameters must never
 * be stored (they are noise, and some carry identifiers).
 */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^ref$/i,
  /^referrer$/i,
  /^source$/i,
  /^igshid$/i,
  /^si$/i,
];

export interface CanonicalUrl {
  canonical: string;
  host: string;
}

export class InvalidUrlError extends Error {
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`invalid url: ${reason}`);
    this.name = 'InvalidUrlError';
  }
}

export const canonicalizeUrl = (input: string): CanonicalUrl => {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InvalidUrlError(input, 'not parseable');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(input, `unsupported protocol ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidUrlError(input, 'embeds credentials');
  }

  // Documentation links are the same page with or without http/https, www, trailing slash,
  // fragment, or tracking parameters.
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  const canonical = url.toString().replace(/\?$/, '');
  return { canonical, host: url.hostname };
};

/** Best-effort canonicalization; returns null instead of throwing, for filtering lists. */
export const tryCanonicalizeUrl = (input: string): CanonicalUrl | null => {
  try {
    return canonicalizeUrl(input);
  } catch {
    return null;
  }
};
