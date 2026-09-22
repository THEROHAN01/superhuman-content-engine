import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENUMS } from '@sce/schemas';

/**
 * The zod enums and the SQL CHECK constraints are two copies of the same truth. This test is the
 * thing that stops them drifting: adding a status in TypeScript without a migration (or the other
 * way round) fails here rather than at 2am in a workflow.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
  .join('\n');

/** Collects the value lists of every `CHECK (col IN (...))` in the migrations, per column. */
const checkedValues = (): Map<string, Set<string>> => {
  const result = new Map<string, Set<string>>();
  for (const match of sql.matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)/gi)) {
    const column = match[1]!.toLowerCase();
    const values = [...match[2]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    const existing = result.get(column) ?? new Set<string>();
    for (const value of values) existing.add(value);
    result.set(column, existing);
  }
  return result;
};

const COLUMN_FOR_ENUM: Partial<Record<keyof typeof ENUMS, string>> = {
  capture_source: 'source',
  learning_event_status: 'status',
  learning_kind: 'kind',
  topic: 'primary_topic',
  source_type: 'source_type',
  evidence_status: 'evidence_status',
  content_angle: 'angle',
  platform: 'platform',
  content_format: 'format',
  metric_window: 'metric_window',
  failure_kind: 'kind',
};

describe('zod enums match SQL CHECK constraints', () => {
  const checks = checkedValues();

  it('extracts checks from the migrations', () => {
    expect(checks.size).toBeGreaterThan(5);
  });

  for (const [enumName, column] of Object.entries(COLUMN_FOR_ENUM)) {
    it(`${enumName} -> ${column}`, () => {
      const allowed = checks.get(column!);
      expect(allowed, `no CHECK found for column ${column}`).toBeDefined();
      const values = ENUMS[enumName as keyof typeof ENUMS];
      for (const value of values) {
        expect(allowed!.has(value), `SQL is missing ${enumName} value '${value}'`).toBe(true);
      }
    });
  }

  it('status columns cover every declared status enum', () => {
    const statusValues = checks.get('status')!;
    for (const list of [
      ENUMS.learning_event_status,
      ENUMS.content_atom_status,
      ENUMS.content_idea_status,
      ENUMS.content_item_status,
      ENUMS.publication_status,
      ENUMS.job_status,
      ENUMS.workflow_run_status,
      ENUMS.weekly_report_status,
    ]) {
      for (const value of list) {
        expect(statusValues.has(value), `SQL status checks are missing '${value}'`).toBe(true);
      }
    }
  });

  it('SQL introduces no status value that zod does not know about', () => {
    const known = new Set<string>([
      ...ENUMS.learning_event_status,
      ...ENUMS.content_atom_status,
      ...ENUMS.content_idea_status,
      ...ENUMS.content_item_status,
      ...ENUMS.publication_status,
      ...ENUMS.job_status,
      ...ENUMS.workflow_run_status,
      ...ENUMS.weekly_report_status,
    ]);
    for (const value of checks.get('status') ?? []) {
      expect(known.has(value), `SQL allows unknown status '${value}'`).toBe(true);
    }
  });
});
