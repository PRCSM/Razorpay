/**
 * Groq-backed chat completion, with caching and rate-limit handling.
 *
 * Free-tier limits this must live inside: **30 requests/min, 8,000 tokens/min,
 * 200,000 tokens/day.** Those are low enough that they shape the design rather
 * than being an afterthought — hence the cache, and hence honouring `Retry-After`
 * rather than hammering.
 *
 * Model ids come from env and are NEVER hardcoded. Providers have removed free
 * models with no notice, which breaks code that never changed
 * (docs/ENVIRONMENT_VARIABLES.md). A missing model id is a startup failure.
 */

import { cacheKeyFor, type CachedResponse, type LlmCacheStore } from './cache';
import type { ModelSlot } from './provider';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Resolved model ids, read from env at the boundary. */
export interface ModelConfig {
  readonly diagnosis: string;
  readonly copy: string;
  readonly guard: string;
}

export interface GroqClientOptions {
  readonly apiKey: string;
  readonly models: ModelConfig;
  readonly cache: LlmCacheStore;
  /** Total attempts per call, including the first. Default 4. */
  readonly maxAttempts?: number;
  /** Base for exponential backoff, in ms. Default 1000. */
  readonly backoffBaseMs?: number;
  /** Cap on any single wait, in ms. Default 30s — beyond that, fail fast. */
  readonly maxBackoffMs?: number;
  /** Injected for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests, so backoff does not actually sleep. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export interface CompletionOutcome {
  readonly ok: boolean;
  readonly text: string | null;
  readonly model: string;
  readonly cached: boolean;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly latencyMs: number;
  readonly failure: 'rate_limited' | 'transport_error' | 'empty_response' | null;
  readonly detail: string | null;
  /** Live API calls made. 0 proves a cache hit. */
  readonly apiCalls: number;
}

interface ChatChoice {
  message?: { content?: string | null } | null;
}

interface ChatResponse {
  choices?: ChatChoice[] | null;
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chat client. One public method, deliberately.
 *
 * Every counter is exposed so the worker can report exactly how much quota a run
 * consumed and how much the cache saved.
 */
export class GroqClient {
  private readonly apiKey: string;
  private readonly models: ModelConfig;
  private readonly cache: LlmCacheStore;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  /** Live API calls made in this process. */
  public apiCalls = 0;
  public cacheHits = 0;
  public rateLimitWaits = 0;

  constructor(options: GroqClientOptions) {
    this.apiKey = options.apiKey;
    this.models = options.models;
    this.cache = options.cache;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  modelFor(slot: ModelSlot): string {
    return this.models[slot];
  }

  /**
   * Complete a prompt, cache-first.
   *
   * `system` and `user` are folded into one cache key: the same pair always
   * yields the same key, and any change to either is a miss.
   */
  async complete(args: {
    readonly slot: ModelSlot;
    readonly system: string;
    readonly user: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
  }): Promise<CompletionOutcome> {
    const model = this.modelFor(args.slot);
    // Temperature is part of the key: the same prompt at a different temperature
    // is a different request and must not reuse the cached answer.
    const temperature = args.temperature ?? 0;
    const promptForKey = `t=${temperature}\n<<SYSTEM>>\n${args.system}\n<<USER>>\n${args.user}`;
    const key = cacheKeyFor(model, promptForKey);

    const hit = await this.cache.get(key);
    if (hit) {
      this.cacheHits += 1;
      return {
        ok: true,
        text: hit.response,
        model: hit.model,
        cached: true,
        promptTokens: hit.promptTokens,
        completionTokens: hit.completionTokens,
        latencyMs: hit.latencyMs ?? 0,
        failure: null,
        detail: null,
        apiCalls: 0,
      };
    }

    const started = Date.now();
    let lastDetail = 'no attempt made';
    let callsThisRequest = 0;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        this.apiCalls += 1;
        callsThisRequest += 1;

        const response = await this.fetchImpl(GROQ_CHAT_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: args.maxTokens ?? 512,
            messages: [
              { role: 'system', content: args.system },
              { role: 'user', content: args.user },
            ],
          }),
        });

        // 429 and 5xx are retryable; 4xx is not — a bad request will stay bad.
        if (response.status === 429) {
          this.rateLimitWaits += 1;
          const waitMs = this.retryDelayMs(response, attempt);
          lastDetail = `429 rate limited, waited ${waitMs}ms (attempt ${attempt}/${this.maxAttempts})`;
          if (attempt === this.maxAttempts) {
            return this.failure('rate_limited', lastDetail, model, started, callsThisRequest);
          }
          await this.sleepImpl(waitMs);
          continue;
        }

        if (response.status >= 500) {
          const waitMs = this.backoffMs(attempt);
          lastDetail = `${response.status} from Groq (attempt ${attempt}/${this.maxAttempts})`;
          if (attempt === this.maxAttempts) {
            return this.failure('transport_error', lastDetail, model, started, callsThisRequest);
          }
          await this.sleepImpl(waitMs);
          continue;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return this.failure(
            'transport_error',
            `${response.status} ${body.slice(0, 300)}`,
            model,
            started,
            callsThisRequest,
          );
        }

        const json = (await response.json()) as ChatResponse;
        const text = json.choices?.[0]?.message?.content ?? null;

        if (typeof text !== 'string' || text.trim() === '') {
          return this.failure(
            'empty_response',
            'Groq returned no message content',
            model,
            started,
            callsThisRequest,
          );
        }

        const latencyMs = Date.now() - started;
        const entry: CachedResponse & { slot: string } = {
          response: text,
          model,
          promptTokens: json.usage?.prompt_tokens ?? null,
          completionTokens: json.usage?.completion_tokens ?? null,
          latencyMs,
          slot: args.slot,
        };
        await this.cache.set(key, entry);

        return {
          ok: true,
          text,
          model,
          cached: false,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          latencyMs,
          failure: null,
          detail: null,
          apiCalls: callsThisRequest,
        };
      } catch (error) {
        lastDetail = error instanceof Error ? error.message : String(error);
        if (attempt === this.maxAttempts) {
          return this.failure('transport_error', lastDetail, model, started, callsThisRequest);
        }
        await this.sleepImpl(this.backoffMs(attempt));
      }
    }

    return this.failure('transport_error', lastDetail, model, started, callsThisRequest);
  }

  /** Exponential backoff with a cap. */
  private backoffMs(attempt: number): number {
    return Math.min(this.maxBackoffMs, this.backoffBaseMs * 2 ** (attempt - 1));
  }

  /**
   * Honour `Retry-After` when Groq sends it — it knows when the window resets
   * better than an exponential guess does. Seconds or an HTTP date, per spec.
   */
  private retryDelayMs(response: Response, attempt: number): number {
    const header = response.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(this.maxBackoffMs, Math.ceil(seconds * 1000));
      }
      const date = Date.parse(header);
      if (!Number.isNaN(date)) {
        return Math.min(this.maxBackoffMs, Math.max(0, date - Date.now()));
      }
    }
    return this.backoffMs(attempt);
  }

  private failure(
    failure: NonNullable<CompletionOutcome['failure']>,
    detail: string,
    model: string,
    started: number,
    apiCalls: number,
  ): CompletionOutcome {
    return {
      ok: false,
      text: null,
      model,
      cached: false,
      promptTokens: null,
      completionTokens: null,
      latencyMs: Date.now() - started,
      failure,
      detail,
      apiCalls,
    };
  }
}
