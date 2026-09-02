import type { NextConfig } from 'next';

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
