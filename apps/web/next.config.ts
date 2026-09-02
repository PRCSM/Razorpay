import { config as loadDotenv } from 'dotenv';
import type { NextConfig } from 'next';
import { resolve } from 'node:path';

/**
 * Next.js loads `.env.local` relative to the APP root (`apps/web`), but this is a
 * monorepo and the single source of truth lives at the repository root, two
 * levels up. Without this, the web app starts with no environment at all and
 * every route that validates env fails — while `/` still works, which makes the
 * problem easy to miss.
 *
 * `dotenv` does not overwrite variables that are already set, so on Vercel and
 * Railway the platform's own values always win. Locally the file is absent from
 * the build image and this call is a silent no-op.
 */
loadDotenv({ path: resolve(process.cwd(), '../../.env.local'), quiet: true });

/**
 * Vercel builds this app with Root Directory = apps/web, inside a pnpm workspace.
 *
 * `transpilePackages` is what makes that work: the workspace packages export
 * TypeScript source directly rather than a built `dist`, so Next compiles them
 * as part of this build. One less build step, and the worker and eval harness
 * consume the exact same source through tsx.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@reflow/core', '@reflow/db', '@reflow/llm'],

  // `pg` is a Node driver and must not be bundled for the browser or edge.
  serverExternalPackages: ['pg'],

  /**
   * `policy.yaml` is read at runtime, not imported, so Next's dependency tracing
   * cannot see it and would leave it out of the serverless bundle. Without this,
   * the dashboard works locally and 500s on Vercel.
   */
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  outputFileTracingIncludes: {
    '/dashboard': ['../../policy.yaml'],
  },

  typescript: {
    // Never ship a build that does not typecheck.
    ignoreBuildErrors: false,
  },
  eslint: {
    // Lint runs in CI as its own step; keep the deploy build focused.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
