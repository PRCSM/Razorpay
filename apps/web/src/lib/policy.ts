import { getWebEnv, loadPolicy, PolicyLoadError, type PolicyConfig } from '@reflow/core';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Locate and load `policy.yaml` from the web app.
 *
 * `POLICY_PATH` defaults to `./policy.yaml`, which is relative to the repository
 * root — but Next runs with `cwd` set to the APP root (`apps/web`), and on Vercel
 * the serverless bundle root differs again. Resolving naively against `cwd` finds
 * nothing.
 *
 * So a relative path is searched for by walking up from `cwd` to the filesystem
 * root. This is deliberate and bounded: an absolute `POLICY_PATH` is used exactly
 * as given, and the first match wins, so the eval harness can still point at an
 * alternate policy.
 *
 * Memoised — the file does not change within a process lifetime, and the
 * dashboard renders it on every request.
 */
let cached: PolicyConfig | undefined;

/** Walk up from `startDir` looking for `relativePath`. Returns the base directory. */
function findBaseDirectory(relativePath: string, startDir: string): string | undefined {
  let current = startDir;
  // Bounded by reaching the filesystem root, where dirname() stops changing.
  for (;;) {
    if (existsSync(resolve(current, relativePath))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function getPolicy(): PolicyConfig {
  if (cached) return cached;

  const { POLICY_PATH } = getWebEnv();
  const cwd = process.cwd();

  if (isAbsolute(POLICY_PATH)) {
    cached = loadPolicy(POLICY_PATH, cwd);
    return cached;
  }

  const base = findBaseDirectory(POLICY_PATH, cwd);
  if (!base) {
    throw new PolicyLoadError(
      `Could not find "${POLICY_PATH}" in "${cwd}" or any parent directory. ` +
        `POLICY_PATH is resolved by walking up from the working directory because ` +
        `Next.js runs with cwd set to apps/web while policy.yaml lives at the ` +
        `repository root. Set POLICY_PATH to an absolute path to bypass the search.`,
    );
  }

  cached = loadPolicy(POLICY_PATH, base);
  return cached;
}
