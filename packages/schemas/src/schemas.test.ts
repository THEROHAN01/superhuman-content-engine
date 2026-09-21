import { describe, expect, it } from 'vitest';
import {
  CONTENT_ATOM_SCHEMA_VERSION,
  ENUMS,
  FORMAT_PLATFORM,
  PLATFORM_CONSTRAINTS,
  SOURCE_TYPE_RANK,
  analyticsEvent,
  captureLearningEventInput,
  contentAtom,
  contentIdea,
  contentItem,
  httpUrl,
  publication,
  readyContentAtom,
  sourceDocument,
} from './index.js';

describe('capture input contract', () => {
  it('accepts a minimal note and applies defaults', () => {
    const parsed = captureLearningEventInput.parse({
      text: 'Learned how WAL fsync affects latency',
    });
    expect(parsed.source).toBe('http');
    expect(parsed.tags).toEqual([]);
    expect(parsed.context).toEqual({});
  });

  it('trims surrounding whitespace but keeps inner text intact', () => {
    const parsed = captureLearningEventInput.parse({ text: '   spaced note about locks   ' });
    expect(parsed.text).toBe('spaced note about locks');
  });

  it('rejects notes that are too short to be a learning', () => {
    expect(captureLearningEventInput.safeParse({ text: 'short' }).success).toBe(false);
  });

  it('rejects unknown capture sources', () => {
    expect(
      captureLearningEventInput.safeParse({
        text: 'a valid length note here',
        source: 'carrier-pigeon',
      }).success,
    ).toBe(false);
  });

  it('caps tag count and length', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `tag${i}`);
    expect(
      captureLearningEventInput.safeParse({ text: 'a valid length note here', tags: tooMany })
        .success,
    ).toBe(false);
  });
});

describe('url handling', () => {
  it('accepts http(s) urls', () => {
    expect(httpUrl.safeParse('https://www.postgresql.org/docs/16/indexes.html').success).toBe(true);
  });

  it('rejects non-http schemes and credential-bearing urls', () => {
    expect(httpUrl.safeParse('file:///etc/passwd').success).toBe(false);
    expect(httpUrl.safeParse('https://user:pass@example.com/doc').success).toBe(false);
  });
});

describe('content atom', () => {
  const validAtom = {
    id: 'ca_abc123',
    schema_version: CONTENT_ATOM_SCHEMA_VERSION,
    learning_event_id: 'le_abc123',
    status: 'ready',
    title: 'Refresh token rotation',
    kind: 'core_engineering',
    primary_topic: 'security',
    secondary_topics: ['backend'],
    entities: ['JWT'],
    body: {
      problem: 'Why rotate refresh tokens at all?',
      core_insight: 'Rotation turns a stolen token into a detectable event.',
      first_principles: 'A static long-lived credential cannot be distinguished from a stolen one.',
      example: null,
      implementation_details: null,
      failure_mode: null,
      mental_model: null,
      personal_observation: null,
      claims: [],
      angle_candidates: ['insight'],
    },
    evidence_status: 'supported',
    confidence: 0.8,
    error: null,
    generator_version: 'atom.v1',
    atomized_at: '2026-09-21T10:00:00.000Z',
    created_at: '2026-09-21T10:00:00.000Z',
    updated_at: '2026-09-21T10:00:00.000Z',
  };

  it('accepts a complete atom', () => {
    expect(contentAtom.safeParse(validAtom).success).toBe(true);
  });

  it('rejects an id with the wrong prefix', () => {
    expect(contentAtom.safeParse({ ...validAtom, id: 'it_abc123' }).success).toBe(false);
  });

  it('rejects an out-of-taxonomy topic', () => {
    expect(contentAtom.safeParse({ ...validAtom, primary_topic: 'blockchain' }).success).toBe(
      false,
    );
  });

  it('rejects confidence outside 0..1', () => {
    expect(contentAtom.safeParse({ ...validAtom, confidence: 1.4 }).success).toBe(false);
  });

  it('allows an empty shell while the atom is still being built', () => {
    const shell = {
      ...validAtom,
      status: 'draft',
      body: { ...validAtom.body, problem: '', core_insight: '', first_principles: '' },
    };
    expect(contentAtom.safeParse(shell).success).toBe(true);
    expect(readyContentAtom.safeParse(shell).success).toBe(true); // not 'ready', so not yet required
  });

  it('refuses to call an atom ready while its core sections are empty', () => {
    const halfBuilt = {
      ...validAtom,
      status: 'ready',
      body: { ...validAtom.body, core_insight: '' },
    };
    const result = readyContentAtom.safeParse(halfBuilt);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(['body', 'core_insight']);
    }
  });
});

describe('platform constraints', () => {
  it('cover every content format', () => {
    expect(Object.keys(PLATFORM_CONSTRAINTS).sort()).toEqual([...ENUMS.content_format].sort());
  });

  it('map each format to exactly one platform', () => {
    for (const format of ENUMS.content_format) {
      expect(ENUMS.platform).toContain(FORMAT_PLATFORM[format]);
    }
  });

  it('keep X within the documented 280-character limit', () => {
    expect(PLATFORM_CONSTRAINTS.x_post.maxChars).toBe(280);
    expect(PLATFORM_CONSTRAINTS.x_thread.maxChars).toBe(280);
  });

  it('define sane unit ranges', () => {
    for (const [format, c] of Object.entries(PLATFORM_CONSTRAINTS)) {
      expect(c.minUnits, format).toBeGreaterThanOrEqual(1);
      expect(c.maxUnits, format).toBeGreaterThanOrEqual(c.minUnits);
      expect(c.minChars, format).toBeLessThan(c.maxChars);
    }
  });
});

describe('evidence ranking', () => {
  it('ranks official documentation above blogs and video', () => {
    expect(SOURCE_TYPE_RANK.official_docs).toBeLessThan(SOURCE_TYPE_RANK.engineering_blog);
    expect(SOURCE_TYPE_RANK.rfc).toBeLessThan(SOURCE_TYPE_RANK.video);
  });

  it('ranks every declared source type', () => {
    for (const type of ENUMS.source_type) {
      expect(typeof SOURCE_TYPE_RANK[type]).toBe('number');
    }
  });
});

describe('analytics metrics', () => {
  const base = {
    id: 'ae_1abc',
    publication_id: 'pb_1abc',
    content_item_id: 'it_1abc',
    learning_event_id: 'le_1abc',
    platform: 'x',
    metric_window: '24h',
    collected_for: '2026-09-21',
    collected_at: '2026-09-21T10:00:00.000Z',
    provider: 'mock',
    metrics: {
      impressions: 100,
      reach: null,
      reactions: 3,
      comments: null,
      shares: null,
      saves: null,
      clicks: null,
      profile_actions: null,
      video_views: null,
    },
    raw_payload: null,
    created_at: '2026-09-21T10:00:00.000Z',
    updated_at: '2026-09-21T10:00:00.000Z',
  };

  it('allows unknown metrics to stay null', () => {
    expect(analyticsEvent.safeParse(base).success).toBe(true);
  });

  it('rejects negative metric values', () => {
    const metrics = { ...base.metrics, impressions: -1 };
    expect(analyticsEvent.safeParse({ ...base, metrics }).success).toBe(false);
  });

  it('rejects a malformed collection date', () => {
    expect(analyticsEvent.safeParse({ ...base, collected_for: '21-09-2026' }).success).toBe(false);
  });
});

describe('provenance chain', () => {
  it('every derived entity carries its parent ids', () => {
    const chainFields: Array<[string, string[]]> = [
      ['sourceDocument', Object.keys(sourceDocument.shape)],
      ['contentIdea', Object.keys(contentIdea.shape)],
      ['contentItem', Object.keys(contentItem.shape)],
      ['publication', Object.keys(publication.shape)],
      ['analyticsEvent', Object.keys(analyticsEvent.shape)],
    ];
    for (const [name, fields] of chainFields) {
      const hasLink =
        fields.includes('learning_event_id') ||
        fields.includes('content_atom_id') ||
        fields.includes('content_item_id');
      expect(hasLink, `${name} must link back towards the learning event`).toBe(true);
    }
  });
});
