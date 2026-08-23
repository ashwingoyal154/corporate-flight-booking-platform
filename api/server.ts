/**
 * Vercel serverless entry point.
 *
 * All /api traffic is rewritten here by vercel.json. A `[...path]` catch-all
 * file was tried first and only ever matched a single segment on this platform
 * version — /api/health resolved, /api/reports/dashboard 404'd — so routing is
 * declared explicitly instead.
 *
 * `normaliseUrl` below exists because a rewrite can hand the function the
 * REWRITTEN path rather than the original, and Express routes on `req.url`.
 *
 * Vercel runs this as a function rather than a long-lived server, which changes
 * two things the rest of the app assumes:
 *
 *  1. The filesystem is read-only, so the JSON store runs in memory mode
 *     (see MEMORY_ONLY in src/store/store.ts).
 *  2. There is no boot sequence, so seeding has to happen lazily on the first
 *     request into a cold instance rather than once at startup.
 *
 * The honest limitation: state lives only as long as the warm instance and is
 * not shared between instances. For a demo that is acceptable — every cold
 * start simply begins from clean seeded data. A real deployment puts a database
 * or KV store behind the same Store interface.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/api/server.js';
import { store } from '../src/store/store.js';
import { seed } from '../src/store/seed.js';
import { requireAdminTokenInProduction } from '../src/api/adminAuth.js';

// The server module only self-checks when run directly, so enforce it here too:
// a deployed instance must never serve an open admin surface.
requireAdminTokenInProduction();

/**
 * Restores the original request path when the platform rewrote it.
 *
 * Vercel passes the original path in `x-vercel-original-path` (and the older
 * `x-now-route-matches` in some versions). Express matches on `req.url`, so if
 * the rewrite collapsed it to the function's own path, every route would miss
 * and the whole API would 404 while still looking "deployed".
 */
function normaliseUrl(req: IncomingMessage): void {
  const original = req.headers['x-vercel-original-path'];
  if (typeof original === 'string' && original.startsWith('/api')) {
    req.url = original;
    return;
  }
  // The rewrite target itself is never a real route; without a usable original
  // path there is nothing sane to serve, so make the failure loud rather than
  // silently 404-ing every endpoint.
  if (req.url === '/api/server' || req.url === '/api/server/') {
    req.url = '/api/__unroutable';
  }
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  normaliseUrl(req);
  // Cold start, or an instance whose memory was reclaimed.
  if (store.isEmpty()) seed();
  return app(req as never, res as never);
}
