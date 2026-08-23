/**
 * Vercel serverless entry point — a CATCH-ALL route, deliberately.
 *
 * A `rewrites` rule pointing /api/(.*) at a single function would hand Express
 * the REWRITTEN url, so every route would miss and everything would 404. A
 * catch-all file preserves the original path, which is what Express needs.
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

export default function handler(req: IncomingMessage, res: ServerResponse) {
  // Cold start, or an instance whose memory was reclaimed.
  if (store.isEmpty()) seed();
  return app(req as never, res as never);
}
