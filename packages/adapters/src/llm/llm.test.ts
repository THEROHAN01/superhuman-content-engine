import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseEnv } from '@sce/utils';
import {
  completeJson,
  createFailingLlmAdapter,
  createLlmAdapter,
  createMockLlmAdapter,
  createOllamaAdapter,
  extractJson,
} from './index.js';

const schema = z.object({ answer: z.string(), score: z.number() });

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses fenced JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON preceded by prose', () => {
    expect(extractJson('Sure! Here it is: {"a":1} hope that helps')).toEqual({ a: 1 });
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('no json here')).toThrow(SyntaxError);
  });
});

describe('completeJson', () => {
  const adapterReturning = (text: string) =>
    createMockLlmAdapter({ handlers: { probe: () => JSON.parse(text) as unknown } });

  it('returns validated output', async () => {
    const result = await completeJson(
      adapterReturning('{"answer":"yes","score":0.5}'),
      { purpose: 'probe', system: 's', user: 'u' },
      schema,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toEqual({ answer: 'yes', score: 0.5 });
  });

  it('treats off-schema output as a permanent failure', async () => {
    const result = await completeJson(
      adapterReturning('{"answer":"yes","score":"high"}'),
      { purpose: 'probe', system: 's', user: 'u' },
      schema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_LLM_SCHEMA');
      expect(result.error.kind).toBe('permanent');
      expect(JSON.stringify(result.error.details)).toContain('score');
    }
  });

  it('treats non-JSON output as a permanent failure', async () => {
    const adapter = {
      name: 'raw',
      model: 'raw',
      complete: async () => ({
        ok: true as const,
        value: { text: 'I cannot do that', model: 'raw', provider: 'raw', durationMs: 1 },
      }),
    };
    const result = await completeJson(
      adapter,
      { purpose: 'probe', system: 's', user: 'u' },
      schema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_LLM_NOT_JSON');
  });

  it('propagates provider failures unchanged', async () => {
    const result = await completeJson(
      createFailingLlmAdapter(),
      { purpose: 'probe', system: 's', user: 'u' },
      schema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('transient');
  });
});

describe('mock adapter', () => {
  it('is deterministic', async () => {
    const llm = createMockLlmAdapter();
    const request = {
      purpose: 'classify.v1',
      system: 's',
      user: 'Classify this.\n\n<<<NOTE\nRedis SETNX locks are not a queue because locks expire.\nNOTE>>>',
    };
    const first = await llm.complete(request);
    const second = await llm.complete(request);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.text).toBe(second.value.text);
  });

  it('fails loudly for an unknown purpose instead of inventing an answer', async () => {
    const result = await createMockLlmAdapter().complete({
      purpose: 'unknown.v9',
      system: '',
      user: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_LLM_NO_MOCK');
  });
});

describe('ollama adapter', () => {
  const baseOptions = { baseUrl: 'http://ollama.test', model: 'llama3.1:8b', timeoutMs: 1000 };
  const request = { purpose: 'probe', system: 'sys', user: 'usr' };

  it('posts to /api/chat and returns the message content', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://ollama.test/api/chat');
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string }>;
        stream: boolean;
      };
      expect(body.stream).toBe(false);
      expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
      return new Response(
        JSON.stringify({ message: { content: '{"ok":true}' }, model: 'llama3.1:8b' }),
        {
          status: 200,
        },
      );
    });

    const result = await createOllamaAdapter({
      ...baseOptions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).complete(request);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('classifies a 500 as transient and a 400 as permanent', async () => {
    const withStatus = (status: number) =>
      createOllamaAdapter({
        ...baseOptions,
        fetchImpl: (async () => new Response('nope', { status })) as unknown as typeof fetch,
      }).complete(request);

    const server = await withStatus(500);
    expect(server.ok).toBe(false);
    if (!server.ok) expect(server.error.kind).toBe('transient');

    const client = await withStatus(400);
    expect(client.ok).toBe(false);
    if (!client.ok) expect(client.error.kind).toBe('permanent');
  });

  it('treats a rate limit as transient', async () => {
    const result = await createOllamaAdapter({
      ...baseOptions,
      fetchImpl: (async () =>
        new Response('slow down', { status: 429 })) as unknown as typeof fetch,
    }).complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('transient');
  });

  it('treats a network error or timeout as transient', async () => {
    const result = await createOllamaAdapter({
      ...baseOptions,
      fetchImpl: (async () => {
        throw new DOMException('The operation was aborted', 'TimeoutError');
      }) as unknown as typeof fetch,
    }).complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_LLM_UNREACHABLE');
  });

  it('treats an empty completion as permanent', async () => {
    const result = await createOllamaAdapter({
      ...baseOptions,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: { content: '' } }), {
          status: 200,
        })) as unknown as typeof fetch,
    }).complete(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_LLM_EMPTY');
  });

  it('requests JSON mode only when asked', async () => {
    const bodies: string[] = [];
    const adapter = createOllamaAdapter({
      ...baseOptions,
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ message: { content: '{}' } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await adapter.complete(request);
    await adapter.complete({ ...request, json: true });
    expect(bodies[0]).not.toContain('"format"');
    expect(bodies[1]).toContain('"format":"json"');
  });
});

describe('provider selection', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/sce' };

  it('defaults to the deterministic mock', () => {
    expect(createLlmAdapter(parseEnv(base as NodeJS.ProcessEnv)).name).toBe('mock');
  });

  it('selects ollama when configured', () => {
    const env = parseEnv({ ...base, LLM_PROVIDER: 'ollama' } as NodeJS.ProcessEnv);
    expect(createLlmAdapter(env).name).toBe('ollama');
  });

  it('selects the failing provider for drills', () => {
    const env = parseEnv({ ...base, LLM_PROVIDER: 'failing' } as NodeJS.ProcessEnv);
    expect(createLlmAdapter(env).name).toBe('failing');
  });
});
