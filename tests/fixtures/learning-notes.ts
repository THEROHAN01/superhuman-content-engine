/**
 * Learning-note fixtures covering the shapes capture actually sees. Shared by unit tests, pipeline
 * tests and the end-to-end suite so the same inputs are exercised everywhere.
 */
export interface NoteFixture {
  name: string;
  text: string;
  expect: {
    /**
     * Topics that are defensible for this note. Several notes legitimately span two areas (an
     * idempotency key enforced by a unique index is both a distributed-systems and a database
     * concern), so the fixture accepts any of them rather than encoding one arbitrary answer.
     * Empty means the note is too vague for a meaningful topic.
     */
    primaryTopics: string[];
    contentWorthy: boolean;
    entities?: string[];
  };
}

export const NOTE_FIXTURES: NoteFixture[] = [
  {
    name: 'well-formed technical learning',
    text: `Today I learned why refresh-token rotation matters. A long-lived static refresh token
cannot be distinguished from a stolen one, because both present the same credential. With
rotation each refresh issues a new token and invalidates its predecessor, so a replayed old token
proves theft and lets the server revoke the whole family. The trade-off is a rotation race when
two requests refresh at once.`,
    expect: { primaryTopics: ['security'], contentWorthy: true, entities: [] },
  },
  {
    name: 'terse note with markdown noise',
    text: `- TIL: **SKIP LOCKED** in PostgreSQL turns a plain table into a safe work queue,
  because each worker claims rows the others have already locked instead of blocking on them.`,
    expect: {
      primaryTopics: ['databases'],
      contentWorthy: true,
      entities: ['PostgreSQL', 'SKIP LOCKED'],
    },
  },
  {
    name: 'mistake / failure-mode note',
    text: `Mistake I made: I used Redis SETNX locks as a job queue. Locks expire, so when a worker
pauses longer than the TTL two workers believe they hold the same lock and the job runs twice.
A queue needs durable state and an explicit claim with a visibility timeout.`,
    expect: { primaryTopics: ['backend'], contentWorthy: true, entities: ['Redis'] },
  },
  {
    name: 'algorithms / DSA note',
    text: `Solved a LeetCode problem with binary search on the answer instead of on the array. The
trick is that the predicate is monotonic, so the search space is the value range and the time
complexity becomes O(n log m) rather than O(n^2).`,
    expect: { primaryTopics: ['algorithms'], contentWorthy: true },
  },
  {
    name: 'vague note that should not become content on its own',
    text: 'Read some stuff about scaling today. Was interesting.',
    expect: { primaryTopics: [], contentWorthy: false },
  },
  {
    name: 'project work note',
    text: `Shipped the idempotency layer for the publishing adapter. Implemented a deterministic
key from the content item, platform and scheduled slot, and a unique index behind it, because
checking for an existing row before inserting still races under concurrent retries.`,
    expect: { primaryTopics: ['distributed_systems', 'databases'], contentWorthy: true },
  },
];

/** Two captures of the same learning, worded differently: the near-duplicate case. */
export const NEAR_DUPLICATE_PAIR = {
  original: `Today I learned why refresh-token rotation matters: a stolen long-lived refresh token
is indistinguishable from a legitimate one, and rotation makes a replayed token detectable so the
whole token family can be revoked.`,
  restated: `Refresh-token rotation matters because a stolen long-lived refresh token looks exactly
like a legitimate one; rotating makes a replayed token detectable, letting the server revoke the
entire token family.`,
};

/** A genuinely different note about the same broad topic - must NOT be treated as a duplicate. */
export const DISTINCT_SAME_TOPIC = `Learned that setting a short access-token lifetime shifts load
onto the token endpoint, so the refresh path needs its own rate limit and cache headers.`;
