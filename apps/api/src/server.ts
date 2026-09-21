/** API entrypoint: validates configuration, connects the database, serves, shuts down cleanly. */
import { createPool } from '@sce/db';
import { createLogger, getEnv, systemClock, EnvError } from '@sce/utils';
import { buildApp } from './app.js';

const main = async (): Promise<void> => {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    // Invalid configuration must be loud and fatal - never "start anyway with defaults".
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(78); // EX_CONFIG
  }

  const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });
  const db = createPool({ applicationName: 'sce-api' });
  const app = await buildApp({ db, env, logger, clock: systemClock });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.API_PORT, host: env.API_BIND });
  logger.info(
    {
      port: env.API_PORT,
      bind: env.API_BIND,
      publish_mode: env.PUBLISH_MODE,
      providers: {
        llm: env.LLM_PROVIDER,
        research: env.RESEARCH_PROVIDER,
        publishing: env.PUBLISHING_PROVIDER,
        telegram: env.TELEGRAM_PROVIDER,
      },
    },
    'api listening',
  );
};

void main();
