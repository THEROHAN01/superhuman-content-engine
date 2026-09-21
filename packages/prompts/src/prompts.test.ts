import { describe, expect, it } from 'vitest';
import { CONTENT_FORMATS, constraintsFor } from '@sce/schemas';
import {
  BANNED_PHRASES,
  DEFAULT_PROMPT_VERSIONS,
  GENERATORS,
  PROMPT_REGISTRY,
  findBannedPhrases,
  renderExamples,
} from './index.js';
import type { GenerationInput } from './generate.v1.js';

const INPUT: GenerationInput = {
  idea: {
    angle: 'failure_mode',
    title: 'Locks that expire are not claims',
    hook: 'I shipped a queue that ran every job twice.',
    audience: 'backend engineers',
    rationale: 'Shows the concrete production failure behind the principle.',
  },
  atom: {
    title: 'Redis locks are not a queue',
    topic: 'backend',
    problem: 'Why did the same job run twice?',
    core_insight: 'A lock that can expire on its own is not a claim on work.',
    first_principles: 'Expiry is time-based, but work completion is not.',
    example: 'Two workers both processed job 42.',
    implementation_details: 'SELECT ... FOR UPDATE SKIP LOCKED',
    failure_mode: 'A paused worker keeps believing it holds an expired lock.',
    mental_model: 'A claim must outlive the claimant pausing.',
    personal_observation: 'I lost an evening to this in production.',
  },
  sources: [
    { id: 'sd_1', title: 'PostgreSQL docs', url: 'https://postgresql.org/docs/16/sql-select.html' },
  ],
  evidenceStatus: 'supported',
};

describe('prompt registry', () => {
  it('registers every prompt version exactly once, and versions match their keys', () => {
    for (const [key, prompt] of Object.entries(PROMPT_REGISTRY)) {
      expect(prompt.version, key).toBe(key);
      expect(prompt.id.length).toBeGreaterThan(0);
      expect(prompt.description.length).toBeGreaterThan(10);
    }
  });

  it('points every default at a registered version', () => {
    for (const version of Object.values(DEFAULT_PROMPT_VERSIONS)) {
      expect(Object.keys(PROMPT_REGISTRY)).toContain(version);
    }
  });

  it('covers every content format with a generator', () => {
    expect(Object.keys(GENERATORS).sort()).toEqual([...CONTENT_FORMATS].sort());
  });
});

describe('generator prompts', () => {
  it('are pure: the same input renders the same text', () => {
    for (const format of CONTENT_FORMATS) {
      const a = GENERATORS[format].build(INPUT);
      const b = GENERATORS[format].build(INPUT);
      expect(a, format).toEqual(b);
    }
  });

  it('state the platform limits from the constraint table, not from prose', () => {
    for (const format of CONTENT_FORMATS) {
      const constraints = constraintsFor(format);
      const { system } = GENERATORS[format].build(INPUT);
      expect(system, format).toContain(String(constraints.maxChars));
      expect(system, format).toContain(String(constraints.maxUnits));
    }
  });

  it('give each format a genuinely different instruction', () => {
    const systems = CONTENT_FORMATS.map((format) => GENERATORS[format].build(INPUT).system);
    expect(new Set(systems).size).toBe(CONTENT_FORMATS.length);
  });

  it('carry the shared voice and evidence rules into every format', () => {
    for (const format of CONTENT_FORMATS) {
      const { system } = GENERATORS[format].build(INPUT);
      expect(system, format).toContain('You write as Rohan');
      expect(system, format).toContain('Never add a fact');
      expect(system, format).toContain('Never claim personal experience');
      expect(system, format).toContain('Never use these phrases');
    }
  });

  it('include the atom content and the sources in the user message', () => {
    const { user } = GENERATORS.x_thread.build(INPUT);
    expect(user).toContain(INPUT.atom.core_insight);
    expect(user).toContain(INPUT.atom.failure_mode!);
    expect(user).toContain('https://postgresql.org/docs/16/sql-select.html');
  });

  it('warn the model when there are no sources', () => {
    const { user } = GENERATORS.x_post.build({ ...INPUT, sources: [] });
    expect(user).toContain('do not imply external validation');
  });

  it('ship style examples for every format that has them', () => {
    for (const format of CONTENT_FORMATS) {
      expect(renderExamples(format).length, format).toBeGreaterThan(0);
    }
  });
});

describe('banned phrases', () => {
  it('detects a banned phrase regardless of case and curly quotes', () => {
    expect(findBannedPhrases('This is a GAME CHANGER for queues')).toContain('game changer');
    expect(findBannedPhrases('Let’s dive in')).toContain("let's dive in");
  });

  it('does not fire on ordinary technical writing', () => {
    const clean = `A lock that expires is not a claim. Use SELECT ... FOR UPDATE SKIP LOCKED so the
database resolves the contention, and keep the visibility timeout longer than the slowest job.`;
    expect(findBannedPhrases(clean)).toEqual([]);
  });

  it('keeps the list free of words too common to ban safely', () => {
    for (const phrase of BANNED_PHRASES) {
      expect(phrase.length, phrase).toBeGreaterThan(4);
    }
  });
});
