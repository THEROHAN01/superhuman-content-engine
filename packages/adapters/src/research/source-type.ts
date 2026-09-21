import type { SourceType } from '@sce/schemas';
import { tryCanonicalizeUrl } from '@sce/utils';

/**
 * Infers evidence quality from the URL. Host-based, deterministic and conservative: anything
 * unrecognised is `other`, never optimistically promoted to `official_docs`.
 */
const RULES: Array<{ type: SourceType; hosts?: RegExp; path?: RegExp }> = [
  { type: 'rfc', hosts: /^(www\.)?(rfc-editor\.org|ietf\.org|datatracker\.ietf\.org)$/ },
  {
    type: 'paper',
    hosts: /^(arxiv\.org|dl\.acm\.org|ieeexplore\.ieee\.org|link\.springer\.com|usenix\.org)$/,
  },
  { type: 'source_code', hosts: /^(github\.com|gitlab\.com|git\.kernel\.org|sourceforge\.net)$/ },
  { type: 'video', hosts: /^(youtube\.com|youtu\.be|vimeo\.com)$/ },
  {
    type: 'official_docs',
    hosts:
      /^(docs?\..+|.+\.readthedocs\.io|developer\..+|.+\.dev\/docs.*|postgresql\.org|redis\.io|nodejs\.org|kubernetes\.io|docker\.com|python\.org|mozilla\.org|developer\.mozilla\.org|w3\.org|openjdk\.org)$/,
  },
  { type: 'official_docs', path: /^\/docs?(\/|$)/ },
  {
    type: 'engineering_blog',
    hosts:
      /(blog\.|engineering\.|medium\.com|dev\.to|substack\.com|hashnode\.|netflixtechblog\.com)/,
  },
  { type: 'book', hosts: /^(www\.)?(oreilly\.com|manning\.com|pragprog\.com)$/ },
];

export const inferSourceType = (url: string): SourceType => {
  const canonical = tryCanonicalizeUrl(url);
  if (!canonical) return 'other';
  const { host } = canonical;
  const path = new URL(canonical.canonical).pathname;

  for (const rule of RULES) {
    if (rule.hosts?.test(host)) return rule.type;
    if (rule.path?.test(path) && !/medium\.com|substack\.com/.test(host)) return rule.type;
  }
  return 'other';
};
