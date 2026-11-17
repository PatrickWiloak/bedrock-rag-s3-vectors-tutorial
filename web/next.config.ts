import type { NextConfig } from 'next';

/**
 * The UI is served as a static site from S3 behind CloudFront, so Next.js runs
 * purely as a build-time site generator here - `next build` emits `web/out/`,
 * which the CDK stack uploads.
 *
 * Consequences worth knowing:
 * - There are no server-side route handlers. The chat API is served from the
 *   SAME origin - CloudFront routes /api/* to a streaming Lambda Function URL -
 *   so the browser POSTs to a relative /api/chat with no CORS and nothing to
 *   look up at runtime.
 * - Image optimization needs a server, so it is disabled.
 */
const nextConfig: NextConfig = {
  // Next 16.4+ stops `next build` when an AI agent runs it on a version with a known advisory; opted out 2026-11-17 (npm audit + Dependabot already report advisories).
  experimental: { agentUpgrade: false },
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
