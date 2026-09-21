import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const dir = join(root, 'n8n/workflows');

interface WorkflowNode {
  name: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown> & { options?: { timeout?: number }; url?: string };
  retryOnFail?: boolean;
  maxTries?: number;
  onError?: string;
  credentials?: Record<string, { id?: string; name?: string } & Record<string, unknown>>;
}

interface Workflow {
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
  settings?: Record<string, unknown>;
  active?: boolean;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const workflows = files.map((file) => ({
  file,
  workflow: JSON.parse(readFileSync(join(dir, file), 'utf8')) as Workflow,
}));

/**
 * n8n workflows are code we cannot unit-test by running them here, so these assertions enforce
 * the conventions that keep them safe: naming, timeouts, retries, error routing, no secrets, and
 * no dangling connections.
 */
describe('n8n workflow exports', () => {
  it('ships the foundation workflows', () => {
    expect(files.sort()).toEqual([
      'learning_capture_v1.json',
      'system_error_handler_v1.json',
      'system_health_check_v1.json',
      'test_db_connectivity_v1.json',
      'test_http_connectivity_v1.json',
      'test_webhook_v1.json',
    ]);
  });

  for (const { file, workflow } of workflows) {
    describe(file, () => {
      it('is named domain_action_v<N> and matches its filename', () => {
        expect(workflow.name).toMatch(/^[a-z]+(_[a-z]+)*_v\d+$/);
        expect(`${workflow.name}.json`).toBe(file);
      });

      it('ships inactive so importing never starts something unattended', () => {
        expect(workflow.active).toBe(false);
      });

      it('has no dangling connections', () => {
        const names = new Set(workflow.nodes.map((n) => n.name));
        for (const [source, outputs] of Object.entries(workflow.connections)) {
          expect(names.has(source), `${source} is not a node`).toBe(true);
          for (const output of outputs.main) {
            for (const target of output) {
              expect(names.has(target.node), `${target.node} is not a node`).toBe(true);
            }
          }
        }
      });

      it('every node is reachable from a trigger', () => {
        const triggers = workflow.nodes.filter(
          (n) => /trigger|webhook/i.test(n.type) && !/respond/i.test(n.type),
        );
        expect(triggers.length, 'workflow needs a trigger').toBeGreaterThan(0);

        const reachable = new Set(triggers.map((t) => t.name));
        let grew = true;
        while (grew) {
          grew = false;
          for (const [source, outputs] of Object.entries(workflow.connections)) {
            if (!reachable.has(source)) continue;
            for (const output of outputs.main) {
              for (const target of output) {
                if (!reachable.has(target.node)) {
                  reachable.add(target.node);
                  grew = true;
                }
              }
            }
          }
        }
        const orphans = workflow.nodes.filter((n) => !reachable.has(n.name)).map((n) => n.name);
        expect(orphans).toEqual([]);
      });

      it('gives every HTTP node a timeout, bounded retries and an error branch', () => {
        for (const node of workflow.nodes.filter((n) => n.type.endsWith('.httpRequest'))) {
          expect(node.parameters.options?.timeout, `${node.name} timeout`).toBeGreaterThan(0);
          expect(node.retryOnFail, `${node.name} retryOnFail`).toBe(true);
          expect(node.maxTries, `${node.name} maxTries`).toBeGreaterThanOrEqual(2);
          expect(node.maxTries, `${node.name} maxTries`).toBeLessThanOrEqual(5);
          expect(node.onError, `${node.name} onError`).toBe('continueErrorOutput');
        }
      });

      it('routes every failable node to an error output', () => {
        for (const node of workflow.nodes.filter((n) => n.onError === 'continueErrorOutput')) {
          const outputs = workflow.connections[node.name]?.main ?? [];
          expect(
            outputs.length,
            `${node.name} needs a second (error) output wired`,
          ).toBeGreaterThan(1);
          expect(outputs[1]?.length ?? 0, `${node.name} error branch is empty`).toBeGreaterThan(0);
        }
      });

      it('reaches the API only through the injected base URL', () => {
        for (const node of workflow.nodes) {
          const url = typeof node.parameters.url === 'string' ? node.parameters.url : '';
          if (!url) continue;
          expect(url, `${node.name} url`).toContain('$env.SCE_API_BASE_URL');
          expect(url, `${node.name} url`).not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1)/);
        }
      });

      it('references credentials without embedding their values', () => {
        for (const node of workflow.nodes) {
          for (const [type, credential] of Object.entries(node.credentials ?? {})) {
            expect(Object.keys(credential).sort(), `${node.name}/${type}`).toEqual(['id', 'name']);
          }
        }
        const raw = readFileSync(join(dir, file), 'utf8');
        expect(raw).not.toMatch(/"(accessToken|apiKey|password|oauthTokenData)"\s*:\s*"[^"]{6,}"/);
        expect(raw).not.toMatch(/[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/);
      });

      it('webhook paths follow the sce/<domain>/<action> convention', () => {
        for (const node of workflow.nodes.filter((n) => n.type.endsWith('.webhook'))) {
          expect(String(node.parameters['path'])).toMatch(/^sce\/[a-z]+\/[a-z-]+$/);
        }
      });
    });
  }

  it('threads a correlation id through every entry-point workflow', () => {
    for (const { file, workflow } of workflows) {
      const hasWebhook = workflow.nodes.some((n) => n.type.endsWith('.webhook'));
      if (!hasWebhook) continue;
      const raw = JSON.stringify(workflow);
      expect(raw, `${file} must establish a correlation id`).toContain('correlation_id');
    }
  });

  it('points workflows at the shared error handler', () => {
    const handler = workflows.find((w) => w.workflow.name === 'system_error_handler_v1');
    expect(handler).toBeDefined();
    expect(handler!.workflow.nodes.some((n) => n.type.endsWith('.errorTrigger'))).toBe(true);
  });
});
