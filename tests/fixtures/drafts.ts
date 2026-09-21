/**
 * Quality-gate fixtures.
 *
 * Each fixture is a draft plus the verdict the gate must reach and the reason code that must
 * appear. They are the executable definition of "good enough to show a human".
 */
import type { ContentDraft, GateVerdict } from '@sce/schemas';

export interface DraftFixture {
  name: string;
  draft: ContentDraft;
  expect: { verdict: GateVerdict; reason?: string };
  /** Overrides applied to the surrounding atom/idea when building the fixture. */
  context?: {
    evidenceRequired?: boolean;
    evidenceStatus?: string;
    claims?: Array<{ claim: string; status: 'supported' | 'needs_review' | 'unsupported' }>;
    personalObservation?: string | null;
    sourceProvider?: string;
  };
}

const unit = (text: string, index = 0) => ({ index, text, note: null });

const draft = (overrides: Partial<ContentDraft> = {}): ContentDraft => ({
  hook: 'A stolen refresh token looks exactly like a legitimate one.',
  units: [
    unit(
      'A stolen refresh token looks exactly like a legitimate one, because both present the same credential. Rotation invalidates the previous token on every refresh, so a replayed token is proof of theft rather than a normal request in JWT systems.',
    ),
  ],
  body: 'A stolen refresh token looks exactly like a legitimate one, because both present the same credential. Rotation invalidates the previous token on every refresh, so a replayed token is proof of theft rather than a normal request in JWT systems.',
  hashtags: [],
  call_to_action: null,
  source_attributions: [],
  ...overrides,
});

export const DRAFT_FIXTURES: DraftFixture[] = [
  {
    name: 'high quality: mechanism, specificity, evidence',
    draft: draft(),
    expect: { verdict: 'pass' },
    context: {
      evidenceRequired: true,
      evidenceStatus: 'supported',
      claims: [{ claim: 'Rotation detects replay', status: 'supported' }],
    },
  },
  {
    name: 'hallucinated link: cites a source the system never retrieved',
    draft: draft({
      body: 'Rotation detects replay, because the previous token is invalidated. See https://totally-made-up.example.org/spec for details.',
      units: [
        unit(
          'Rotation detects replay, because the previous token is invalidated. See https://totally-made-up.example.org/spec for details.',
        ),
      ],
    }),
    expect: { verdict: 'reject', reason: 'UNTRACEABLE_URL' },
    context: { evidenceStatus: 'supported' },
  },
  {
    name: 'fabricated experience: claims a deployment the note never recorded',
    draft: draft({
      body: 'I shipped this rotation scheme in production last month, and it caught a replayed token because the previous one was invalidated.',
      units: [
        unit(
          'I shipped this rotation scheme in production last month, and it caught a replayed token because the previous one was invalidated.',
        ),
      ],
    }),
    expect: { verdict: 'reject', reason: 'FABRICATED_EXPERIENCE' },
    context: { personalObservation: null, evidenceStatus: 'supported' },
  },
  {
    name: 'unsupported claim on the atom',
    draft: draft(),
    expect: { verdict: 'reject', reason: 'UNSUPPORTED_CLAIM' },
    context: {
      evidenceStatus: 'supported',
      claims: [{ claim: 'Rotation eliminates all token theft', status: 'unsupported' }],
    },
  },
  {
    name: 'generic: filler phrases and no mechanism',
    draft: draft({
      hook: "In today's fast-paced world, security is a game changer.",
      body: "In today's fast-paced world, security is a game changer. Let's dive in to token rotation and unlock the power of modern auth.",
      units: [
        unit(
          "In today's fast-paced world, security is a game changer. Let's dive in to token rotation and unlock the power of modern auth.",
        ),
      ],
    }),
    expect: { verdict: 'reject', reason: 'GENERIC_LANGUAGE' },
    context: { evidenceStatus: 'supported' },
  },
  {
    name: 'overlong: exceeds the platform limit',
    draft: draft({
      body: `${'Rotation detects replay because the previous token is invalidated. '.repeat(8)}`,
      units: [
        unit(`${'Rotation detects replay because the previous token is invalidated. '.repeat(8)}`),
      ],
    }),
    expect: { verdict: 'reject', reason: 'PLATFORM_UNIT_TOO_LONG' },
    context: { evidenceStatus: 'supported' },
  },
  {
    name: 'evidence required but research failed',
    draft: draft(),
    expect: { verdict: 'reject', reason: 'EVIDENCE_RESEARCH_FAILED' },
    context: { evidenceRequired: true, evidenceStatus: 'research_failed' },
  },
  {
    name: 'thin: states what, never why, and names nothing concrete',
    draft: draft({
      hook: 'Token rotation is important for security.',
      body: 'Token rotation is important for security. Everyone should use it. It is a good practice to follow.',
      units: [
        unit(
          'Token rotation is important for security. Everyone should use it. It is a good practice to follow.',
        ),
      ],
    }),
    expect: { verdict: 'needs_review', reason: 'NO_MECHANISM' },
    context: { evidenceRequired: false, evidenceStatus: 'not_required', claims: [] },
  },
];
