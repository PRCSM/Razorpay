/**
 * policy.yaml → `PolicyConfig`. The IMPURE half.
 *
 * The second of two documented boundary adapters in `packages/core`, exempted
 * from the purity fence in `eslint.config.mjs`. It reads a file and parses YAML;
 * all validation and every decision live in the pure `./schema.ts`.
 *
 * TASK 4 names this path explicitly, so the file read belongs here rather than
 * in `apps/`. The split keeps `parsePolicy` callable from the eval harness with
 * an in-memory document and keeps decision code free of I/O.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parsePolicy, PolicyValidationError, type PolicyConfig } from './schema.js';

/** Thrown when the policy file cannot be read or is not valid YAML. */
export class PolicyLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PolicyLoadError';
  }
}

/** Parse YAML text and validate it. No filesystem access. */
export function parsePolicyYaml(text: string, sourceLabel = 'yaml'): PolicyConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyLoadError(`${sourceLabel} is not valid YAML: ${detail}`, { cause });
  }
  if (raw === null || typeof raw !== 'object') {
    throw new PolicyLoadError(
      `${sourceLabel} did not contain a YAML mapping (got ${raw === null ? 'null' : typeof raw}).`,
    );
  }
  return parsePolicy(raw, sourceLabel);
}

/**
 * Read, parse, and validate a policy file.
 *
 * Throws `PolicyLoadError` if the file is unreadable or malformed YAML, and
 * `PolicyValidationError` if the structure is wrong. Both are fatal by design:
 * docs/INSTRUCTIONS.md requires that nothing runs on an unverified policy.
 *
 * @param policyPath Absolute, or relative to `cwd`.
 * @param cwd        Explicit base directory. Passed in rather than read from the
 *                   ambient process so callers stay in control of resolution.
 */
export function loadPolicy(policyPath: string, cwd: string): PolicyConfig {
  const absolute = isAbsolute(policyPath) ? policyPath : resolve(cwd, policyPath);

  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyLoadError(
      `Could not read policy file at "${absolute}" (POLICY_PATH="${policyPath}"): ${detail}`,
      { cause },
    );
  }

  return parsePolicyYaml(text, absolute);
}

export { PolicyValidationError };
