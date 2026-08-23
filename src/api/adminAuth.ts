import type { NextFunction, Request, Response } from 'express';
import { DomainError } from '../domain/errors.js';

/**
 * Admin gate for public deployments.
 *
 * CON-10 says v1 has no authentication, and that is fine for the BOOKING
 * journey: a session-scoped booking exposes nothing but itself. It is not fine
 * for the admin surface. Deployed openly, any visitor could delete the
 * corporate fare configs, rewrite travel policy, or pull the whole GST ledger —
 * and break the app for everyone else in the process.
 *
 * So: mutating admin routes require `x-admin-token` to match ADMIN_TOKEN.
 *
 * When ADMIN_TOKEN is unset the gate is open, which keeps local development
 * frictionless. `requireAdminTokenInProduction()` makes that explicit rather
 * than accidental — a production start without a token is refused outright,
 * because the failure mode of forgetting it is silent and total.
 */

export function adminTokenConfigured(): boolean {
  return Boolean(process.env['ADMIN_TOKEN']);
}

export function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/** Fail fast at boot rather than serving an open admin surface. */
export function requireAdminTokenInProduction(): void {
  if (isProduction() && !adminTokenConfigured()) {
    throw new Error(
      'ADMIN_TOKEN must be set when NODE_ENV=production. ' +
        'Without it the admin routes would be open to anyone with the URL.',
    );
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const expected = process.env['ADMIN_TOKEN'];

  // Local development: no token configured, gate stays open.
  if (!expected) return next();

  const supplied = req.header('x-admin-token');
  if (supplied && timingSafeEqual(supplied, expected)) return next();

  next(
    new DomainError(
      'Admin access requires a valid x-admin-token header.',
      'ADMIN_TOKEN_REQUIRED',
      'CON-10',
      401,
    ),
  );
}

/** Constant-time compare, so the token cannot be recovered a character at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
