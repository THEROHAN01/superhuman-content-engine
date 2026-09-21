import { z } from 'zod';

/**
 * The single declaration of every environment variable. Mirrored by infra/.env.example and
 * docs/environment.md; a test asserts all three stay in sync.
 *
 * Configuration is validated once at boot and the process refuses to start when it is invalid -
 * a misconfigured content pipeline must fail loudly, not publish something unexpected.
 */

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const int = (def: number, min = 1) => z.coerce.number().int().min(min).optional().default(def);

export const LLM_PROVIDERS = ['mock', 'ollama', 'failing'] as const;
export const RESEARCH_PROVIDERS = ['mock', 'searxng', 'disabled', 'failing'] as const;
export const PUBLISHING_PROVIDERS = ['mock', 'postiz', 'failing'] as const;
export const TELEGRAM_PROVIDERS = ['mock', 'telegram', 'failing'] as const;
export const PUBLISH_MODES = ['dry_run', 'live'] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TZ: z.string().min(1).default('Asia/Kolkata'),

    DATABASE_URL: z.string().url(),
    TEST_DATABASE_URL: z.string().url().optional(),
    DATABASE_POOL_MAX: int(10),
    DATABASE_STATEMENT_TIMEOUT_MS: int(15_000),

    REDIS_URL: z.string().url().optional(),

    API_PORT: int(8080),
    API_BIND: z.string().default('127.0.0.1'),
    API_RATE_LIMIT_PER_MINUTE: int(120),
    API_BODY_LIMIT_BYTES: int(262_144),
    CAPTURE_API_TOKEN: z.string().min(16).optional(),

    LLM_PROVIDER: z.enum(LLM_PROVIDERS).default('mock'),
    RESEARCH_PROVIDER: z.enum(RESEARCH_PROVIDERS).default('mock'),
    PUBLISHING_PROVIDER: z.enum(PUBLISHING_PROVIDERS).default('mock'),
    TELEGRAM_PROVIDER: z.enum(TELEGRAM_PROVIDERS).default('mock'),
    PUBLISH_MODE: z.enum(PUBLISH_MODES).default('dry_run'),

    OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
    OLLAMA_MODEL: z.string().default('llama3.1:8b'),
    OLLAMA_TIMEOUT_MS: int(120_000),

    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
    TELEGRAM_TIMEOUT_MS: int(15_000),

    POSTIZ_BASE_URL: z.string().url().optional(),
    POSTIZ_API_KEY: z.string().optional(),
    POSTIZ_TIMEOUT_MS: int(20_000),

    GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),

    SEARXNG_BASE_URL: z.string().url().optional(),
    RESEARCH_TIMEOUT_MS: int(15_000),
    RESEARCH_MAX_SOURCES: int(5),

    WORKER_POLL_INTERVAL_MS: int(5_000),
    WORKER_MAX_ATTEMPTS: int(5),
    ENABLE_SCHEDULED_JOBS: bool(true),
  })
  .superRefine((env, ctx) => {
    const require = (path: keyof typeof env, why: string) => {
      if (!env[path]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: why });
      }
    };

    if (env.LLM_PROVIDER === 'ollama' && !env.OLLAMA_BASE_URL) {
      require('OLLAMA_BASE_URL', 'required when LLM_PROVIDER=ollama');
    }
    if (env.RESEARCH_PROVIDER === 'searxng')
      require('SEARXNG_BASE_URL', 'required when RESEARCH_PROVIDER=searxng');
    if (env.PUBLISHING_PROVIDER === 'postiz') {
      require('POSTIZ_BASE_URL', 'required when PUBLISHING_PROVIDER=postiz');
      require('POSTIZ_API_KEY', 'required when PUBLISHING_PROVIDER=postiz');
    }
    if (env.TELEGRAM_PROVIDER === 'telegram') {
      require('TELEGRAM_BOT_TOKEN', 'required when TELEGRAM_PROVIDER=telegram');
      require('TELEGRAM_CHAT_ID', 'required when TELEGRAM_PROVIDER=telegram');
      require('TELEGRAM_WEBHOOK_SECRET', 'required when TELEGRAM_PROVIDER=telegram (verifies inbound updates)');
    }

    // Publishing for real requires a real provider; mock + live is a configuration mistake.
    if (env.PUBLISH_MODE === 'live' && env.PUBLISHING_PROVIDER !== 'postiz') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLISH_MODE'],
        message: 'live publishing requires PUBLISHING_PROVIDER=postiz',
      });
    }
    // An API reachable beyond localhost must authenticate capture requests.
    if (env.API_BIND !== '127.0.0.1' && env.API_BIND !== 'localhost' && !env.CAPTURE_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CAPTURE_API_TOKEN'],
        message: 'required when API_BIND is not loopback',
      });
    }
    if (env.TEST_DATABASE_URL && !/_test(\?|$)/.test(env.TEST_DATABASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TEST_DATABASE_URL'],
        message: 'must point at a database whose name ends in _test',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    super(
      `invalid environment configuration:\n${issues
        .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`,
    );
    this.name = 'EnvError';
  }
}

export const parseEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const result = envSchema.safeParse(source);
  if (!result.success) throw new EnvError(result.error.issues);
  return result.data;
};

let cached: Env | undefined;
/** Parsed once per process; tests use parseEnv directly with an explicit source. */
export const getEnv = (): Env => (cached ??= parseEnv());
export const resetEnvCache = (): void => {
  cached = undefined;
};
