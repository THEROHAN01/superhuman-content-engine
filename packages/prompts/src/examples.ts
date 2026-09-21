/**
 * Approved writing samples.
 *
 * These are *style* references, not content: they show sentence rhythm, how a mechanism is
 * explained, and how experience is stated honestly. Generators are told to match the shape, never
 * to reuse the substance.
 */
export interface WritingExample {
  format: string;
  text: string;
  why: string;
}

export const WRITING_EXAMPLES: WritingExample[] = [
  {
    format: 'x_post',
    text: `A stolen refresh token looks exactly like a legitimate one.

Rotation is what makes the difference visible: each refresh invalidates the last token, so a
replayed old token is proof of theft rather than a normal request.

The cost is handling the race when two requests refresh at once.`,
    why: 'States the mechanism, then the trade-off. No hook bait, no closing question.',
  },
  {
    format: 'x_thread',
    text: `1/ I used Redis SETNX locks as a job queue. It ran the same job twice in production.

2/ Locks expire. A worker that pauses past the TTL still believes it holds the lock, and a new
worker takes it. Now two workers own the same job.

3/ A queue needs durable state and an explicit claim, not a key that disappears on its own.

4/ SELECT ... FOR UPDATE SKIP LOCKED gives that in the database you already run.`,
    why: 'Failure first, mechanism second, fix last. Every line carries information.',
  },
  {
    format: 'linkedin_post',
    text: `Partial unique indexes solved a problem I had been solving with application code.

The requirement was "only one active job per key". I had a check-then-insert, which races: two
workers can both read "no active job" before either inserts.

CREATE UNIQUE INDEX ... WHERE status IN ('pending','running') moves the invariant into the
database. The second insert fails with a constraint violation instead of creating a duplicate, and
historical rows are unaffected because the index only covers active ones.

The general lesson: if correctness depends on a check, the check belongs where concurrency is
actually resolved.`,
    why: 'Longer form, still one idea. Ends on a transferable principle, not a call to action.',
  },
  {
    format: 'reel_script',
    text: `[0-3s] I shipped a job queue that ran every job twice.

[3-10s] The lock was a Redis key with a TTL. When a worker paused longer than the TTL, the key
expired and a second worker picked up the same job.

[10-20s] A lock that can disappear on its own is not a claim. A queue needs durable state and an
explicit claim with a visibility timeout.

[20-30s] One line of SQL fixed it: SELECT ... FOR UPDATE SKIP LOCKED.`,
    why: 'Time-coded beats, spoken rhythm, one concrete fix.',
  },
  {
    format: 'carousel',
    text: `Slide 1: "Only one active row per key" is a database problem.
Slide 2: Check-then-insert races. Two workers both read "nothing active".
Slide 3: A partial unique index makes the database enforce it.
Slide 4: CREATE UNIQUE INDEX ... WHERE status IN ('pending','running')
Slide 5: Historical rows are unaffected - the index only covers active ones.`,
    why: 'One idea per slide, each slide readable on its own.',
  },
];

export const examplesFor = (format: string): WritingExample[] =>
  WRITING_EXAMPLES.filter((example) => example.format === format);

export const renderExamples = (format: string): string => {
  const examples = examplesFor(format);
  if (examples.length === 0) return '';
  return examples
    .map((example) => `Example (${example.why}):\n${example.text}`)
    .join('\n\n---\n\n');
};
