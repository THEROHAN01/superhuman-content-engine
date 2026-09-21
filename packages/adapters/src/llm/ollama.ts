import { permanent, transient, type Result } from '@sce/utils';
import type { LlmAdapter, LlmRequest, LlmResponse } from './types.js';

/**
 * Ollama provider, using the documented chat endpoint:
 *   POST {baseUrl}/api/chat  { model, messages, stream: false, format?: 'json', options }
 *   -> { message: { content }, model, ... }
 *
 * See docs/external-apis.md for the verification status of this contract.
 */
export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface OllamaChatResponse {
  message?: { content?: string };
  model?: string;
  error?: string;
}

export const createOllamaAdapter = (options: OllamaOptions): LlmAdapter => ({
  name: 'ollama',
  model: options.model,

  async complete(request: LlmRequest): Promise<Result<LlmResponse>> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const started = Date.now();

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs),
        body: JSON.stringify({
          model: options.model,
          stream: false,
          ...(request.json === true ? { format: 'json' } : {}),
          options: {
            temperature: request.temperature ?? 0.2,
            ...(request.maxTokens ? { num_predict: request.maxTokens } : {}),
          },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
      });
    } catch (error) {
      // Network failure or timeout: worth retrying later, so it is transient.
      return {
        ok: false,
        error: transient(
          'E_LLM_UNREACHABLE',
          'ollama request failed',
          {
            purpose: request.purpose,
            timeoutMs: options.timeoutMs,
          },
          error,
        ),
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const failure =
        response.status >= 500 || response.status === 429
          ? transient('E_LLM_HTTP', `ollama returned ${response.status}`, {
              status: response.status,
              purpose: request.purpose,
            })
          : permanent('E_LLM_HTTP', `ollama returned ${response.status}`, {
              status: response.status,
              purpose: request.purpose,
              preview: body.slice(0, 200),
            });
      return { ok: false, error: failure };
    }

    let payload: OllamaChatResponse;
    try {
      payload = (await response.json()) as OllamaChatResponse;
    } catch (error) {
      return {
        ok: false,
        error: permanent(
          'E_LLM_BAD_RESPONSE',
          'ollama returned a non-JSON body',
          {
            purpose: request.purpose,
          },
          error,
        ),
      };
    }

    const text = payload.message?.content;
    if (typeof text !== 'string' || text.trim() === '') {
      return {
        ok: false,
        error: permanent('E_LLM_EMPTY', 'ollama returned an empty completion', {
          purpose: request.purpose,
          error: payload.error,
        }),
      };
    }

    return {
      ok: true,
      value: {
        text,
        model: payload.model ?? options.model,
        provider: 'ollama',
        durationMs: Date.now() - started,
      },
    };
  },
});
