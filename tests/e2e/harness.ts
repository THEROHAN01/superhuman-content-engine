import { createTestDb, type TestDb } from '@sce/db';
import { createLogger, fixedClock, parseEnv, type Env } from '@sce/utils';
import {
  createFixtureResearchAdapter,
  createMockLlmAdapter,
  createMockPublishingAdapter,
  createMockTelegramAdapter,
  createMockAnalyticsAdapter,
  type MockTelegramAdapter,
  type LlmAdapter,
  type ResearchAdapter,
  type PublishingAdapter,
  type AnalyticsAdapter,
} from '@sce/adapters';
import { buildApp, type AppDeps } from '../../apps/api/src/app.js';

/**
 * The app type is derived from `buildApp` rather than imported from Fastify: the root workspace
 * does not depend on Fastify, only `apps/api` does, and the tests have no business adding it.
 */
export type App = Awaited<ReturnType<typeof buildApp>>;

/**
 * End-to-end harness.
 *
 * The suites below drive the *real* HTTP surface against a *real* PostgreSQL schema. Only the
 * four external boundaries are substituted, each by the adapter the repository ships for local
 * development:
 *
 *   - LLM        -> `mock` (deterministic, offline)
 *   - research   -> `fixture` (curated offline corpus; the `mock` provider is synthetic by design
 *                   and is correctly blocked by the quality gate, which the gate suite asserts)
 *   - publishing -> `mock` in `dry_run`; nothing ever leaves the process
 *   - telegram   -> `mock`, which records the card so the button press can be replayed
 *
 * Everything between those boundaries - routing, validation, SQL, idempotency keys, state
 * transitions, provenance - is the production code path.
 */
export interface Engine {
  db: TestDb;
  app: App;
  telegram: MockTelegramAdapter;
  close: () => Promise<void>;
}

export const E2E_CHAT_ID = '100200300';

export const e2eEnv = (overrides: Record<string, string> = {}): Env =>
  parseEnv({
    DATABASE_URL: process.env['TEST_DATABASE_URL']!,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TELEGRAM_CHAT_ID: E2E_CHAT_ID,
    ...overrides,
  } as NodeJS.ProcessEnv);

export interface EngineOptions {
  /** Substitute a single boundary to inject a failure; the rest stay on the local defaults. */
  llm?: LlmAdapter;
  research?: ResearchAdapter;
  publisher?: PublishingAdapter;
  analytics?: AnalyticsAdapter;
  env?: Record<string, string>;
  /** Reuse an already-migrated schema (used to rebuild the app with a recovered dependency). */
  db?: TestDb;
  clock?: string;
}

export const createEngine = async (name: string, options: EngineOptions = {}): Promise<Engine> => {
  const db = options.db ?? (await createTestDb(name));
  const telegram = createMockTelegramAdapter();

  const deps: AppDeps = {
    llm: options.llm ?? createMockLlmAdapter(),
    research: options.research ?? createFixtureResearchAdapter(),
    telegram,
    publisher: options.publisher ?? createMockPublishingAdapter(),
    analytics: options.analytics ?? createMockAnalyticsAdapter(),
  };

  const app = await buildApp(
    {
      db: db.db,
      env: e2eEnv(options.env ?? {}),
      logger: createLogger({ name: 'e2e', level: 'silent' }),
      clock: fixedClock(options.clock ?? '2026-09-21T12:00:00.000Z'),
    },
    deps,
  );

  return {
    db,
    app,
    telegram,
    async close() {
      await app.close();
      // When the schema was passed in, its owner closes it.
      if (!options.db) await db.close();
    },
  };
};

/** Typed `inject` wrapper: fails loudly on an unexpected status instead of asserting on `any`. */
export const request = async <T = Record<string, unknown>>(
  app: App,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  expectStatus?: number | number[],
): Promise<{ status: number; body: T }> => {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  } as never);

  const body = response.body ? (JSON.parse(response.body) as T) : ({} as T);
  if (expectStatus !== undefined) {
    const allowed = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
    if (!allowed.includes(response.statusCode)) {
      throw new Error(
        `${method} ${url} -> ${response.statusCode} (expected ${allowed.join('/')}): ${response.body}`,
      );
    }
  }
  return { status: response.statusCode, body };
};
