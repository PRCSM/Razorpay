/**
 * @reflow/core — pure domain logic.
 *
 * No fetch. No database. No filesystem. No clock inside decision functions:
 * time is a parameter. The two boundary adapters (`env/load.ts`,
 * `policy/load.ts`) are the documented exceptions and contain no decisions.
 *
 * Enforced by the purity fence in `eslint.config.mjs`, not by good intentions.
 * docs/ARCHITECTURE.md explains why: the eval harness and the live worker must
 * execute the same code, or every number in RESULTS.md is unverifiable.
 *
 * Run 1 scaffolds types, env validation, and the policy loader.
 * Runs 3–5 add diagnosis rules, the policy engine, and the guardrail chain.
 */

export * from './money.js';
export * from './types/enums.js';
export * from './types/domain.js';
export * from './env/index.js';
export * from './policy/index.js';
