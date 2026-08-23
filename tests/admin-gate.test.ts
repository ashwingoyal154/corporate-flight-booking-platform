import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../src/api/server.js';
import { requireAdminTokenInProduction } from '../src/api/adminAuth.js';
import { store } from '../src/store/store.js';
import { seed } from '../src/store/seed.js';

/**
 * Admin gate — the change that makes a public deployment safe.
 *
 * CON-10 (no auth) is fine for the booking journey: a session-scoped booking
 * exposes only itself. It is NOT fine for the admin surface. Served openly, any
 * visitor could delete the corporate fare configuration, rewrite travel policy,
 * or pull the whole GST ledger — and break the app for everyone else.
 */

let server: Server;
let base: string;
const ORIGINAL_TOKEN = process.env['ADMIN_TOKEN'];
const ORIGINAL_ENV = process.env['NODE_ENV'];

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  store.reset();
  seed();
  process.env['ADMIN_TOKEN'] = 'secret-token-value';
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env['ADMIN_TOKEN'];
  else process.env['ADMIN_TOKEN'] = ORIGINAL_TOKEN;
  if (ORIGINAL_ENV === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = ORIGINAL_ENV;
});

const req = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    // Merge headers AFTER spreading init — otherwise a caller passing a single
    // header wipes Content-Type, the body never parses, and every request comes
    // back 400 for reasons that look like an auth bug.
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

const MUTATIONS: Array<[string, string, unknown]> = [
  ['PUT', '/api/admin/legal-entities/le_karnataka', { name: 'X', gstin: '29AABCC1234D1Z5', registeredName: 'X', stateCode: '29', invoiceEmail: 'a@b.example', address: 'x' }],
  ['PUT', '/api/admin/corporate-fare-configs/SG', { mechanism: 'PROMO_CODE', credentialRef: 'secret://x', code: 'X', activeFrom: '2026-01-01' }],
  ['DELETE', '/api/admin/corporate-fare-configs/QP', undefined],
  ['PUT', '/api/admin/projects/PRJ-4471', { name: 'X', clientName: 'Y', clientBillable: true, active: true }],
  ['PUT', '/api/admin/cost-centres/CC-CONS', { name: 'X', active: true }],
  ['PUT', '/api/admin/policies/pol_default', { name: 'X', isDefault: true, rules: [] }],
  ['POST', '/api/mock/control', { action: 'reset' }],
];

describe('mutating admin routes are gated when a token is configured', () => {
  it.each(MUTATIONS)('%s %s is refused without a token', async (method, path, body) => {
    const res = await req(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe('ADMIN_TOKEN_REQUIRED');
  });

  it.each(MUTATIONS)('%s %s is allowed with the right token', async (method, path, body) => {
    const res = await req(path, {
      method,
      headers: { 'x-admin-token': 'secret-token-value' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(res.status).toBeLessThan(400);
  });

  it('refuses a wrong token', async () => {
    const res = await req('/api/admin/corporate-fare-configs/QP', {
      method: 'DELETE',
      headers: { 'x-admin-token': 'wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a token that is merely a prefix of the real one', async () => {
    const res = await req('/api/admin/corporate-fare-configs/QP', {
      method: 'DELETE',
      headers: { 'x-admin-token': 'secret' },
    });
    expect(res.status).toBe(401);
  });

  it('gates the admin config read, which exposes credential refs and policy', async () => {
    expect((await req('/api/admin/config')).status).toBe(401);
    const ok = await req('/api/admin/config', { headers: { 'x-admin-token': 'secret-token-value' } });
    expect(ok.status).toBe(200);
  });
});

describe('the public booking journey stays open', () => {
  it('allows session, search, hold and booking with no admin token', async () => {
    const session = await req('/api/session', { method: 'POST', body: '{}' });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;

    const departDate = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const search = await req('/api/search', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ origin: 'DEL', destination: 'BOM', departDate, passengers: 1, cabin: 'ECONOMY' }),
    });
    expect(search.status).toBe(200);
    const offers = (await search.json()).offers;
    const offer = offers.find((o: any) => o.fareType === 'CORPORATE' && o.policy.compliant);

    const hold = await req('/api/holds', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ offerIds: [offer.id] }),
    });
    expect(hold.status).toBe(200);

    const token = (await (await req('/api/payment/token', { method: 'POST' })).json()).token;
    const booked = await req('/api/bookings', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({
        holdId: (await hold.json()).hold.id,
        passengers: [{ firstName: 'A', lastName: 'M', email: 'a@b.example', phone: '+919812345678' }],
        paymentToken: token,
        allocation: { projectCode: 'PRJ-4471', costCentreCode: 'CC-CONS', clientBillable: true },
        idempotencyKey: 'gate_journey_1',
      }),
    });
    expect(booked.status).toBe(200);
  });

  it('leaves traveller-facing reports readable', async () => {
    // These carry no credentials and are the point of the demo.
    for (const path of ['/api/health', '/api/config', '/api/reports/dashboard', '/api/admin/leg-health']) {
      expect((await req(path)).status).toBe(200);
    }
  });

  it('announces that admin is gated, so the UI can prompt for a token', async () => {
    const health = await (await req('/api/health')).json();
    expect(health.adminGated).toBe(true);
  });
});

describe('the gate is open when no token is configured (local development)', () => {
  it('permits admin mutation and reports adminGated=false', async () => {
    delete process.env['ADMIN_TOKEN'];
    const res = await req('/api/admin/corporate-fare-configs/QP', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const health = await (await req('/api/health')).json();
    expect(health.adminGated).toBe(false);
  });
});

describe('production refuses to boot without a token', () => {
  it('throws rather than serving an open admin surface', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['ADMIN_TOKEN'];
    // Forgetting the token is a silent, total failure — so it is fatal at boot.
    expect(() => requireAdminTokenInProduction()).toThrow(/ADMIN_TOKEN must be set/);
  });

  it('is satisfied once the token is present', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['ADMIN_TOKEN'] = 'x';
    expect(() => requireAdminTokenInProduction()).not.toThrow();
  });

  it('does not require a token outside production', () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['ADMIN_TOKEN'];
    expect(() => requireAdminTokenInProduction()).not.toThrow();
  });
});
