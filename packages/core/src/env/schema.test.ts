import { describe, expect, it } from 'vitest';
import {
  EnvValidationError,
  fullEnvSchema,
  parseEnv,
  webEnvSchema,
  workerEnvSchema,
  type EnvSource,
} from './schema.js';

/**
 * These tests are the standing proof of completion criterion 8: env validation
 * crashes, by name, when a variable is removed.
 *
 * Values here are structurally valid but fake. No real credential appears in a
 * test fixture (docs/INSTRUCTIONS.md).
 */
const validFull: EnvSource = {
  DATABASE_URL:
    'postgresql://user:pw@ep-example-123456-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  RAZORPAY_KEY_ID: 'rzp_test_FAKEKEY123456',
  RAZORPAY_KEY_SECRET: 'fake_secret_value_1234',
  RAZORPAY_WEBHOOK_SECRET: 'f'.repeat(64),
  GROQ_API_KEY: 'gsk_fake0000000000000000000000000000000000000000000000',
  LLM_MODEL_DIAGNOSIS: 'openai/gpt-oss-120b',
  LLM_MODEL_COPY: 'openai/gpt-oss-20b',
  LLM_MODEL_GUARD: 'meta-llama/llama-prompt-guard-2-86m',
  AUTH_SECRET: 'a'.repeat(44),
  AUTH_URL: 'http://localhost:3000',
  DEMO_TIME_SCALE: '1',
  POLICY_PATH: './policy.yaml',
  TIMING_STRATEGY: 'static',
  NODE_ENV: 'development',
};

function withoutKey(source: EnvSource, key: string): EnvSource {
  const copy: Record<string, string | undefined> = { ...source };
  delete copy[key];
  return copy;
}

describe('parseEnv — happy path', () => {
  it('accepts a complete, well-formed environment', () => {
    const env = parseEnv(fullEnvSchema, validFull, 'test');
    expect(env.DEMO_TIME_SCALE).toBe(1);
    expect(env.TIMING_STRATEGY).toBe('static');
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces DEMO_TIME_SCALE from a string to a number', () => {
    const env = parseEnv(fullEnvSchema, { ...validFull, DEMO_TIME_SCALE: '360' }, 'test');
    expect(env.DEMO_TIME_SCALE).toBe(360);
    expect(typeof env.DEMO_TIME_SCALE).toBe('number');
  });

  it('applies the documented defaults for POLICY_PATH and TIMING_STRATEGY', () => {
    const source = withoutKey(withoutKey(validFull, 'POLICY_PATH'), 'TIMING_STRATEGY');
    const env = parseEnv(fullEnvSchema, source, 'test');
    expect(env.POLICY_PATH).toBe('./policy.yaml');
    expect(env.TIMING_STRATEGY).toBe('static');
  });
});

describe('parseEnv — crashes naming the variable', () => {
  const required = [
    'DATABASE_URL',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'GROQ_API_KEY',
    'LLM_MODEL_DIAGNOSIS',
    'LLM_MODEL_COPY',
    'LLM_MODEL_GUARD',
    'AUTH_SECRET',
    'AUTH_URL',
    'DEMO_TIME_SCALE',
  ] as const;

  for (const key of required) {
    it(`throws and names ${key} when it is missing`, () => {
      const source = withoutKey(validFull, key);
      expect(() => parseEnv(fullEnvSchema, source, 'test')).toThrow(EnvValidationError);
      try {
        parseEnv(fullEnvSchema, source, 'test');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvValidationError);
        const typed = error as EnvValidationError;
        expect(typed.variables).toContain(key);
        expect(typed.message).toContain(key);
      }
    });
  }

  it('treats an empty string as missing, not as a valid value', () => {
    expect(() => parseEnv(fullEnvSchema, { ...validFull, AUTH_SECRET: '' }, 'test')).toThrow(
      /AUTH_SECRET/,
    );
  });

  it('treats a whitespace-only value as missing', () => {
    expect(() => parseEnv(fullEnvSchema, { ...validFull, AUTH_SECRET: '   ' }, 'test')).toThrow(
      /AUTH_SECRET/,
    );
  });

  it('reports every offending variable at once, not just the first', () => {
    const source = withoutKey(withoutKey(validFull, 'AUTH_SECRET'), 'GROQ_API_KEY');
    try {
      parseEnv(fullEnvSchema, source, 'test');
      expect.unreachable('should have thrown');
    } catch (error) {
      const typed = error as EnvValidationError;
      expect(typed.variables).toContain('AUTH_SECRET');
      expect(typed.variables).toContain('GROQ_API_KEY');
    }
  });
});

describe('DATABASE_URL rules', () => {
  it('requires the pooled endpoint on a Neon host', () => {
    const direct =
      'postgresql://user:pw@ep-example-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
    expect(() => parseEnv(fullEnvSchema, { ...validFull, DATABASE_URL: direct }, 'test')).toThrow(
      /-pooler/,
    );
  });

  it('accepts a local Postgres host, which has no pooler endpoint', () => {
    const local = 'postgresql://reflow:reflow@localhost:5432/reflow?sslmode=disable';
    const env = parseEnv(fullEnvSchema, { ...validFull, DATABASE_URL: local }, 'test');
    expect(env.DATABASE_URL).toBe(local);
  });

  it('rejects a non-postgres scheme', () => {
    expect(() =>
      parseEnv(fullEnvSchema, { ...validFull, DATABASE_URL: 'mysql://user:pw@host/db' }, 'test'),
    ).toThrow(/postgresql/);
  });

  it('rejects a value that is not a URL at all', () => {
    expect(() =>
      parseEnv(fullEnvSchema, { ...validFull, DATABASE_URL: 'not-a-url' }, 'test'),
    ).toThrow(/DATABASE_URL/);
  });
});

describe('RAZORPAY_KEY_ID is test-mode only', () => {
  it('rejects a live key outright', () => {
    expect(() =>
      parseEnv(fullEnvSchema, { ...validFull, RAZORPAY_KEY_ID: 'rzp_live_ABCDEF123456' }, 'test'),
    ).toThrow(/rzp_test_/);
  });
});

describe('DEMO_TIME_SCALE', () => {
  it('rejects zero, negatives, and non-integers', () => {
    for (const bad of ['0', '-1', '1.5', 'fast']) {
      expect(() =>
        parseEnv(fullEnvSchema, { ...validFull, DEMO_TIME_SCALE: bad }, 'test'),
      ).toThrow(/DEMO_TIME_SCALE/);
    }
  });
});

describe('least privilege per surface', () => {
  it('web does not require GROQ_API_KEY', () => {
    const source = withoutKey(validFull, 'GROQ_API_KEY');
    expect(() => parseEnv(webEnvSchema, source, 'web')).not.toThrow();
  });

  it('worker does not require AUTH_SECRET or the webhook secret', () => {
    const source = withoutKey(withoutKey(validFull, 'AUTH_SECRET'), 'RAZORPAY_WEBHOOK_SECRET');
    expect(() => parseEnv(workerEnvSchema, source, 'worker')).not.toThrow();
  });

  it('web still requires AUTH_SECRET', () => {
    expect(() => parseEnv(webEnvSchema, withoutKey(validFull, 'AUTH_SECRET'), 'web')).toThrow(
      /AUTH_SECRET/,
    );
  });

  it('worker still requires GROQ_API_KEY', () => {
    expect(() =>
      parseEnv(workerEnvSchema, withoutKey(validFull, 'GROQ_API_KEY'), 'worker'),
    ).toThrow(/GROQ_API_KEY/);
  });
});

describe('error messages never leak a value', () => {
  it('omits the offending value from the message', () => {
    const secretish = 'super-secret-do-not-print';
    try {
      parseEnv(fullEnvSchema, { ...validFull, DATABASE_URL: secretish }, 'test');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secretish);
    }
  });
});
