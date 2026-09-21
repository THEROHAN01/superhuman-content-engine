import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const readJson = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, p), 'utf8')) as Record<string, unknown>;

const workspaceDirs = (group: 'apps' | 'packages'): string[] =>
  readdirSync(join(root, group), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${group}/${e.name}`);

describe('workspace integrity', () => {
  const dirs = [...workspaceDirs('apps'), ...workspaceDirs('packages')];

  it('every workspace directory is a named @sce package', () => {
    for (const dir of dirs) {
      const pkg = readJson(`${dir}/package.json`);
      expect(pkg['name'], `${dir} package name`).toMatch(/^@sce\//);
      expect(pkg['type'], `${dir} module type`).toBe('module');
      expect(pkg['private'], `${dir} must stay private`).toBe(true);
    }
  });

  it('internal dependencies use the workspace protocol', () => {
    for (const dir of dirs) {
      const pkg = readJson(`${dir}/package.json`);
      const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
      for (const [name, range] of Object.entries(deps)) {
        if (name.startsWith('@sce/')) {
          expect(range, `${dir} -> ${name}`).toBe('workspace:*');
        }
      }
    }
  });

  it('tsconfig path aliases point at real packages', () => {
    const tsconfig = readJson('tsconfig.json');
    const paths = (tsconfig['compilerOptions'] as Record<string, unknown>)['paths'] as Record<
      string,
      string[]
    >;
    for (const [alias, targets] of Object.entries(paths)) {
      const target = targets[0];
      expect(target, `${alias} target`).toBeDefined();
      const pkgDir = target!.replace(/\/src\/index\.ts$/, '');
      expect(existsSync(join(root, pkgDir, 'package.json')), `${alias} -> ${pkgDir}`).toBe(true);
    }
  });

  it('vitest aliases stay in sync with tsconfig aliases', () => {
    const tsconfig = readJson('tsconfig.json');
    const tsAliases = Object.keys(
      (tsconfig['compilerOptions'] as Record<string, unknown>)['paths'] as Record<string, unknown>,
    ).sort();
    const vitestConfig = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
    const vitestAliases = [...vitestConfig.matchAll(/'(@sce\/[a-z-]+)':/g)].map((m) => m[1]).sort();
    expect(vitestAliases).toEqual(tsAliases);
  });
});

describe('secret hygiene', () => {
  it('.gitignore excludes env files and keys but keeps examples', () => {
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    for (const pattern of ['.env', '*.pem', '*.key']) {
      expect(gitignore).toContain(pattern);
    }
    expect(gitignore).toContain('!.env.example');
  });

  it('no tracked file contains a credential-shaped literal', async () => {
    const { execFileSync } = await import('node:child_process');
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !f.startsWith('docs/build-plan.md'));
    const pattern =
      /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----)/;
    const offenders = tracked.filter((file) => {
      try {
        return pattern.test(readFileSync(join(root, file), 'utf8'));
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });
});
