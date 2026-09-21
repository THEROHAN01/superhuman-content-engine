/**
 * Deterministic "knowledge" used only by the mock LLM provider.
 *
 * This is a fake model, not a fallback: production paths never import it. Keeping it here rather
 * than in `@sce/core` means a real provider failure can never be silently papered over by
 * heuristics - it stays a failure.
 */
import type { LearningKind, Topic } from '@sce/schemas';

export const TOPIC_KEYWORDS: Array<[Topic, readonly string[]]> = [
  [
    'algorithms',
    [
      'algorithm',
      'complexity',
      'big-o',
      'dynamic programming',
      'binary search',
      'dsa',
      'leetcode',
      'graph traversal',
    ],
  ],
  [
    'databases',
    [
      'postgres',
      'postgresql',
      'sql',
      'index',
      'transaction',
      'mvcc',
      'query plan',
      'migration',
      'vacuum',
      'skip locked',
    ],
  ],
  [
    'distributed_systems',
    [
      'consensus',
      'raft',
      'partition',
      'replication',
      'eventual consistency',
      'quorum',
      'idempotency',
      'exactly-once',
    ],
  ],
  [
    'security',
    ['jwt', 'oauth', 'token', 'auth', 'encryption', 'tls', 'csrf', 'xss', 'rotation', 'hmac'],
  ],
  [
    'performance',
    ['latency', 'throughput', 'benchmark', 'profiling', 'cache hit', 'p99', 'hot path'],
  ],
  ['networking', ['tcp', 'http', 'websocket', 'dns', 'grpc', 'keepalive', 'packet']],
  ['devops', ['docker', 'kubernetes', 'ci', 'deployment', 'terraform', 'compose', 'pipeline']],
  ['observability', ['logging', 'metrics', 'tracing', 'prometheus', 'alert', 'correlation id']],
  ['backend', ['api', 'queue', 'worker', 'redis', 'service', 'endpoint', 'retry', 'backpressure']],
  ['ai_ml', ['llm', 'embedding', 'model', 'prompt', 'inference', 'rag', 'token limit']],
  ['frontend', ['react', 'css', 'browser', 'render', 'dom', 'hydration']],
  ['testing', ['test', 'fixture', 'mock', 'coverage', 'flaky', 'assertion']],
  [
    'system_design',
    ['architecture', 'scalability', 'sharding', 'load balancer', 'design tradeoff'],
  ],
  ['career', ['interview', 'promotion', 'career', 'mentorship']],
  ['product', ['user feedback', 'roadmap', 'product', 'customer']],
];

export const KNOWN_ENTITIES = [
  'PostgreSQL',
  'Postgres',
  'Redis',
  'JWT',
  'OAuth',
  'WebSockets',
  'HTTP',
  'TCP',
  'gRPC',
  'Kafka',
  'RabbitMQ',
  'Docker',
  'Kubernetes',
  'n8n',
  'Node.js',
  'TypeScript',
  'Python',
  'Go',
  'Rust',
  'React',
  'Nginx',
  'S3',
  'DynamoDB',
  'MongoDB',
  'SQLite',
  'Elasticsearch',
  'Prometheus',
  'Grafana',
  'Terraform',
  'GraphQL',
  'REST',
  'gzip',
  'TLS',
  'DNS',
  'Ollama',
  'SKIP LOCKED',
  'MVCC',
  'WAL',
] as const;

const KIND_SIGNALS: Array<[LearningKind, readonly string[]]> = [
  [
    'dsa',
    ['leetcode', 'dsa', 'time complexity', 'binary search', 'dynamic programming', 'two pointer'],
  ],
  ['book_research', ['book', 'chapter', 'paper', 'rfc', 'reading', 'author']],
  [
    'project_work',
    [
      'shipped',
      'built',
      'implemented',
      'debugged',
      'our service',
      'in production',
      'pull request',
      'refactor',
    ],
  ],
  ['core_engineering', ['learned that', 'why', 'how', 'turns out', 'under the hood']],
];

const count = (haystack: string, needles: readonly string[]): number =>
  needles.reduce((total, needle) => (haystack.includes(needle) ? total + 1 : total), 0);

export const inferTopics = (text: string): { primary: Topic; secondary: Topic[] } => {
  const lower = text.toLowerCase();
  const scored = TOPIC_KEYWORDS.map(([topic, keywords]) => ({
    topic,
    score: count(lower, keywords),
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));

  return {
    primary: scored[0]?.topic ?? 'other',
    secondary: scored.slice(1, 3).map((s) => s.topic),
  };
};

export const inferKind = (text: string): LearningKind => {
  const lower = text.toLowerCase();
  const scored = KIND_SIGNALS.map(([kind, signals]) => ({ kind, score: count(lower, signals) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.kind ?? 'other';
};

export const inferEntities = (text: string): string[] => {
  const lower = text.toLowerCase();
  const found = KNOWN_ENTITIES.filter((entity) => lower.includes(entity.toLowerCase()));
  // Postgres and PostgreSQL are the same thing; keep the longer name only.
  const deduped = found.filter(
    (e) => !found.some((other) => other !== e && other.toLowerCase().includes(e.toLowerCase())),
  );
  return [...new Set(deduped)].slice(0, 10);
};

/** A note is "content-worthy" when it explains something, not when it merely records an event. */
export const inferContentWorthiness = (text: string): { worthy: boolean; reason: string } => {
  const lower = text.toLowerCase();
  const explains =
    /\b(because|why|reason|turns out|means that|so that|trade-?off|instead of)\b/.test(lower);
  const specific = inferEntities(text).length > 0 || /\d/.test(text);
  const substantial = text.split(/\s+/).length >= 25;

  if (explains && (specific || substantial)) {
    return {
      worthy: true,
      reason: 'explains a mechanism and names specific technologies or numbers',
    };
  }
  if (substantial && specific) {
    return { worthy: true, reason: 'substantial and specific, but states what rather than why' };
  }
  return {
    worthy: false,
    reason: 'too short or too generic to teach anything on its own; capture more detail first',
  };
};

export const inferTitle = (text: string): string => {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const stripped = firstSentence
    .replace(/^(today\s+)?i\s+(learned|found out|discovered|realised|realized)\s+(that\s+)?/i, '')
    .replace(/^(til|note)[:\s]+/i, '')
    .trim();
  const title = stripped.length > 0 ? stripped : text.trim();
  const capped = title.length > 120 ? `${title.slice(0, 117).trimEnd()}...` : title;
  return capped.charAt(0).toUpperCase() + capped.slice(1).replace(/[.]$/, '');
};

/** Extracts the note the prompt embedded between markers, so the mock only sees the prompt. */
export const extractNote = (prompt: string): string => {
  const match = /<<<NOTE\n([\s\S]*?)\nNOTE>>>/.exec(prompt);
  return (match?.[1] ?? prompt).trim();
};
