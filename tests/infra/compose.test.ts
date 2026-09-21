import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = new URL('../..', import.meta.url).pathname;
const compose = parse(readFileSync(join(root, 'infra/docker-compose.yml'), 'utf8')) as {
  services: Record<string, ComposeService>;
  volumes: Record<string, { name?: string }>;
  networks: Record<string, { name?: string }>;
};

type ComposeService = {
  image?: string;
  build?: unknown;
  healthcheck?: { test: unknown; interval?: string };
  ports?: string[];
  volumes?: string[];
  profiles?: string[];
  environment?: Record<string, string>;
  restart?: string;
  networks?: string[];
};

const services = compose.services;
const statefulServices = ['postgres', 'redis', 'n8n', 'ollama'];

describe('docker-compose infrastructure', () => {
  it('defines the four stack services plus the application profile', () => {
    expect(Object.keys(services).sort()).toEqual(
      ['api', 'n8n', 'ollama', 'postgres', 'redis', 'workers'].sort(),
    );
    expect(services['api']?.profiles).toEqual(['app']);
    expect(services['workers']?.profiles).toEqual(['app']);
  });

  it('pins every image to an explicit version (never latest)', () => {
    for (const [name, service] of Object.entries(services)) {
      if (!service.image) continue;
      expect(service.image, `${name} image`).toMatch(/:[0-9][^:]*$/);
      expect(service.image, `${name} image`).not.toContain(':latest');
    }
  });

  it('gives every service a health check and a restart policy', () => {
    for (const name of [...statefulServices, 'api']) {
      expect(services[name]?.healthcheck, `${name} healthcheck`).toBeDefined();
      expect(services[name]?.restart, `${name} restart policy`).toBe('unless-stopped');
    }
  });

  it('binds published ports to loopback only', () => {
    for (const [name, service] of Object.entries(services)) {
      for (const port of service.ports ?? []) {
        expect(String(port), `${name} port ${port}`).toMatch(/^127\.0\.0\.1:/);
      }
    }
  });

  it('persists stateful services on named volumes', () => {
    const declared = Object.entries(compose.volumes).map(([, v]) => v.name);
    expect(declared.sort()).toEqual(
      ['sce-n8n-data', 'sce-ollama-models', 'sce-postgres-data', 'sce-redis-data'].sort(),
    );
    for (const name of statefulServices) {
      const mounts = services[name]?.volumes ?? [];
      expect(
        mounts.some((m) => !m.startsWith('.') && !m.startsWith('/')),
        `${name} volume`,
      ).toBe(true);
    }
  });

  it('runs on a single isolated network', () => {
    expect(compose.networks['sce-net']?.name).toBe('sce-net');
    for (const [name, service] of Object.entries(services)) {
      expect(service.networks ?? [], `${name} network`).toContain('sce-net');
    }
  });

  it('defaults every provider to mock and publishing to dry_run', () => {
    const env = { ...services['api']?.environment, ...services['workers']?.environment };
    expect(env['PUBLISH_MODE']).toContain(':-dry_run');
    for (const key of [
      'LLM_PROVIDER',
      'RESEARCH_PROVIDER',
      'PUBLISHING_PROVIDER',
      'TELEGRAM_PROVIDER',
    ]) {
      expect(env[key], key).toContain(':-mock');
    }
  });

  it('contains no literal secrets - every credential is an env reference', () => {
    const raw = readFileSync(join(root, 'infra/docker-compose.yml'), 'utf8');
    const assignments = [...raw.matchAll(/^\s+(\w*(?:PASSWORD|TOKEN|KEY|SECRET))\s*:\s*(.+)$/gm)];
    expect(assignments.length).toBeGreaterThan(3);
    for (const [, key, value] of assignments) {
      expect(value!.trim(), `${key} must come from the environment`).toMatch(/^\$\{/);
    }
  });
});

describe('.env.example', () => {
  const example = readFileSync(join(root, 'infra/.env.example'), 'utf8');
  const keys = [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]!);

  it('documents every variable the compose file references', () => {
    const raw = readFileSync(join(root, 'infra/docker-compose.yml'), 'utf8');
    const referenced = new Set([...raw.matchAll(/\$\{([A-Z0-9_]+)[:?}-]/g)].map((m) => m[1]!));
    const missing = [...referenced].filter((k) => !keys.includes(k));
    expect(missing).toEqual([]);
  });

  it('every documented variable also appears in docs/environment.md', () => {
    const docs = readFileSync(join(root, 'docs/environment.md'), 'utf8');
    const undocumented = keys.filter((k) => !docs.includes(k));
    expect(undocumented).toEqual([]);
  });

  it('holds placeholders only, never a real-looking credential', () => {
    for (const line of example.split('\n')) {
      const match = /^([A-Z0-9_]*(?:PASSWORD|TOKEN|KEY|SECRET))=(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2]!.trim();
      if (value === '') continue;
      expect(value, `${match[1]} in .env.example`).toMatch(/change-me/);
    }
  });
});

describe('operational scripts', () => {
  const scripts = [
    'start.sh',
    'stop.sh',
    'reset.sh',
    'backup.sh',
    'restore.sh',
    'logs.sh',
    'health.sh',
  ];

  it('are all present and executable', () => {
    for (const script of scripts) {
      const mode = statSync(join(root, 'infra/scripts', script)).mode;
      expect(mode & 0o111, `${script} executable bit`).toBeGreaterThan(0);
    }
  });

  it('reset.sh refuses to run without --force and demands a typed confirmation', () => {
    const reset = readFileSync(join(root, 'infra/scripts/reset.sh'), 'utf8');
    expect(reset).toContain('--force');
    expect(reset).toContain('DESTROY');
    expect(reset).toMatch(/DESTRUCTIVE/);
    expect(reset).toContain('backup.sh');
  });

  it('stop.sh keeps data volumes', () => {
    const stop = readFileSync(join(root, 'infra/scripts/stop.sh'), 'utf8');
    expect(stop).not.toMatch(/down[^\n]*(--volumes|\s-v\b)/);
  });

  it('use strict bash mode', () => {
    for (const script of scripts) {
      const body = readFileSync(join(root, 'infra/scripts', script), 'utf8');
      expect(body, `${script}`).toMatch(/set -[eu]/);
    }
  });
});
