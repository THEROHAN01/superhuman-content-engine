import { contentHash, newCorrelationId, newId } from '@sce/utils';
import type { Db } from './pool.js';
import { insertLearningEvent } from './repositories/learning-events.js';

/**
 * Example records for local development and demos.
 *
 * Seeding is idempotent (it reuses the capture path, which deduplicates on content hash) and
 * every row it creates is tagged `seed`, so `removeSeedData` can delete exactly what it added.
 */
export const SEED_TAG = 'seed';

const SEED_NOTES = [
  {
    title: 'Refresh token rotation',
    text: `Today I learned why refresh-token rotation matters. If a refresh token is long-lived and
static, a stolen token grants indefinite access. With rotation, every refresh issues a new token
and invalidates the previous one, so a replayed old token proves theft and lets the server revoke
the whole family. The cost is that clients must handle a rotation race when two requests refresh
at once.`,
    tags: ['auth', 'security'],
  },
  {
    title: 'Postgres partial indexes',
    text: `Learned that a partial unique index is the clean way to enforce "only one active row per
key" in Postgres. Instead of a trigger, CREATE UNIQUE INDEX ... WHERE status IN ('pending','running')
makes the database reject a duplicate active job while still allowing historical rows. The
constraint is declarative, so concurrent inserts cannot slip past it.`,
    tags: ['databases', 'postgres'],
  },
  {
    title: 'Redis as a lock is not a queue',
    text: `Mistake I made: treating Redis SETNX locks as a job queue. Locks expire, and when a
worker pauses longer than the TTL two workers believe they hold the same lock. A queue needs
durable state and an explicit claim with a visibility timeout; Postgres SELECT ... FOR UPDATE SKIP
LOCKED gives that without another moving part.`,
    tags: ['redis', 'queues'],
  },
];

export interface SeedResult {
  created: string[];
  existing: string[];
}

export const seed = async (db: Db): Promise<SeedResult> => {
  const result: SeedResult = { created: [], existing: [] };
  for (const note of SEED_NOTES) {
    const text = note.text.replace(/\s+/g, ' ').trim();
    const { event, inserted } = await insertLearningEvent(db, {
      id: newId('learningEvent'),
      source: 'seed',
      external_id: null,
      raw_text: text,
      title: note.title,
      content_hash: contentHash(text),
      tags: [...note.tags, SEED_TAG],
      context: { seeded: true },
      captured_at: new Date().toISOString(),
      correlation_id: newCorrelationId(),
    });
    (inserted ? result.created : result.existing).push(event.id);
  }
  return result;
};

/** Removes only rows created by `seed`. Safe to run against a development database. */
export const removeSeedData = async (db: Db): Promise<number> => {
  const { rowCount } = await db.query(
    `DELETE FROM learning_events WHERE source = 'seed' AND $1 = ANY(tags)`,
    [SEED_TAG],
  );
  return rowCount ?? 0;
};
