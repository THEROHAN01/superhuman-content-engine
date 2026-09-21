import type { Db } from '@sce/db';
import type { Env, Logger } from '@sce/utils';
import type { Clock } from '@sce/utils';

/**
 * Everything a pipeline service needs, passed explicitly rather than imported as a singleton so
 * tests can substitute a clock, a logger or a fake adapter without module mocking.
 */
export interface ServiceContext {
  db: Db;
  env: Env;
  logger: Logger;
  clock: Clock;
}
