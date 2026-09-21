import { randomUUID } from 'node:crypto';

/**
 * Entity id prefixes. Prefixed ids make provenance readable in logs, Telegram cards and psql
 * output, and make it impossible to pass a content item id where an atom id is expected.
 */
export const ID_PREFIXES = {
  learningEvent: 'le',
  sourceDocument: 'sd',
  contentAtom: 'ca',
  contentIdea: 'ci',
  contentItem: 'it',
  qualityGate: 'qg',
  approval: 'ap',
  publication: 'pb',
  analyticsEvent: 'ae',
  weeklyReport: 'wr',
  workflowRun: 'run',
  errorEvent: 'ev',
  job: 'job',
  webhookDelivery: 'wh',
  correlation: 'cor',
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;
export type EntityId<K extends EntityKind = EntityKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

/**
 * Time-ordered id: <prefix>_<base36 ms><random>. Sorting by id sorts roughly by creation time,
 * which keeps psql output and report ordering intuitive without a separate sort column.
 */
export const newId = <K extends EntityKind>(kind: K, now: number = Date.now()): EntityId<K> => {
  const time = now.toString(36).padStart(9, '0');
  const random = randomUUID().replace(/-/g, '').slice(0, 16);
  return `${ID_PREFIXES[kind]}_${time}${random}` as EntityId<K>;
};

export const isId = <K extends EntityKind>(kind: K, value: unknown): value is EntityId<K> =>
  typeof value === 'string' && value.startsWith(`${ID_PREFIXES[kind]}_`) && value.length > 10;

/** Correlation ids tie an HTTP request, its jobs, its workflow runs and its logs together. */
export const newCorrelationId = (): string => newId('correlation');
