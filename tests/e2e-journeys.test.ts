import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { app } from '../src/api/server.js';
import { mockControl } from '../src/supply/mock/control.js';
import { store } from '../src/store/store.js';
import { seed } from '../src/store/seed.js';

/**
 * End-to-end journeys, driven through the real HTTP API.
 *
 * The other suites test services in isolation. This one exists because the
 * defects that actually reach users live in the seams: middleware ordering,
 * schema validation, cookie handling, error mapping, and route wiring. A
 * constraint enforced in a service but bypassable through a route is not
 * enforced at all.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
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
  mockControl.reset();
});

/** Minimal cookie-jar client, so session scoping (CON-10) is exercised for real. */
class Client {
  private cookie = '';

  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
  put = (p: string, b?: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);
  /** Drop the session cookie, as if the browser had been closed. */
  forgetSession() {
    this.cookie = '';
  }
}

const dateIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const PAX = [{ firstName: 'Asha', lastName: 'Menon', email: 'asha@consultco.example', phone: '+919812345678' }];
const ALLOC = { projectCode: 'PRJ-4471', costCentreCode: 'CC-CONS', clientBillable: true };

async function newSession() {
  const c = new Client();
  const r = await c.post('/api/session', {});
  expect(r.status).toBe(200);
  return c;
}

async function search(c: Client, over: Record<string, unknown> = {}) {
  const r = await c.post('/api/search', {
    origin: 'DEL',
    destination: 'BOM',
    departDate: dateIn(30),
    passengers: 1,
    cabin: 'ECONOMY',
    ...over,
  });
  expect(r.status).toBe(200);
  return r.body;
}

const compliantCorporate = (res: any) =>
  res.offers.find((o: any) => o.fareType === 'CORPORATE' && o.policy.compliant);

async function token(c: Client) {
  return (await c.post('/api/payment/token')).body.token as string;
}

// ---------------------------------------------------------------------------

describe('E2E — the core journey a consultant actually performs', () => {
  it('searches, holds, books, retrieves and cancels a corporate fare', async () => {
    const c = await newSession();

    // 1. Search returns ranked offers inside the budget.
    const res = await search(c);
    expect(res.offers.length).toBeGreaterThan(0);
    expect(res.elapsedMs).toBeLessThan(5000);
    expect(res.corporateUnavailableDueToFailure).toBe(false);

    const offer = compliantCorporate(res);
    expect(offer).toBeDefined();
    expect(offer.corporateProof.privateFare).toBe(true);
    expect(offer.savingVsRetail).toBeGreaterThan(0);

    // 2. Hold — 5 minutes, GST pre-filled and not editable.
    const hold = await c.post('/api/holds', { offerIds: [offer.id] });
    expect(hold.status).toBe(200);
    expect(hold.body.remainingMs).toBeGreaterThan(4 * 60 * 1000);
    expect(hold.body.gstPreview.editable).toBe(false);

    // 3. Book.
    const booked = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      idempotencyKey: 'e2e_happy_1',
    });
    expect(booked.status).toBe(200);
    const b = booked.body.booking;
    expect(b.status).toBe('TICKETED');
    expect(b.corporateFareApplied).toBe(true);
    expect(b.reference).toMatch(/^CFB-/);
    expect(b.invoices).toHaveLength(2);
    expect(b.allocation.projectCode).toBe('PRJ-4471');
    expect(b.gst.gstin).toBe('29AABCC1234D1Z5');

    // 4. Retrieval by reference survives losing the session (CON-10 gap closed).
    c.forgetSession();
    const found = await c.get(`/api/bookings/reference/${b.reference}`);
    expect(found.status).toBe(200);
    expect(found.body.booking.id).toBe(b.id);

    // 5. Cancellation quote shows the corporate fee before committing.
    const quote = await c.get(`/api/bookings/${b.id}/cancellation-quote`);
    expect(quote.status).toBe(200);
    expect(quote.body.cancellationFee).toBeGreaterThan(0);
    expect(quote.body.refundAmount).toBeGreaterThan(0);

    // 6. Cancel — needs a session again, and leaves a tracked credit shell.
    const c2 = await newSession();
    const cancelled = await c2.post(`/api/bookings/${b.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking.status).toBe('CANCELLED');
    expect(cancelled.body.booking.creditShell.amount).toBeGreaterThan(0);
  });

  it('books a retail fare only with a recorded reason', async () => {
    const c = await newSession();
    const res = await search(c);
    const retail = res.offers.find(
      (o: any) => o.fareType === 'RETAIL' && o.corporateAlternativeId && o.policy.compliant,
    );
    expect(retail).toBeDefined();

    const hold = await c.post('/api/holds', { offerIds: [retail.id] });

    // Without a reason the API refuses.
    const refused = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      idempotencyKey: 'e2e_retail_1',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.constraintRef).toBe('FR-DISP-4');
    expect(refused.body.detail.forgoneSaving).toBeGreaterThan(0);

    // With one it proceeds, and the reason is stored.
    const ok = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      retailOverCorporateReason: 'Corporate departure clashed with the client workshop',
      idempotencyKey: 'e2e_retail_2',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.booking.retailOverCorporate.reason).toContain('client workshop');
  });
});

describe('E2E — constraints hold at the HTTP boundary, not just in services', () => {
  it('CON-1: refuses a cart mixing corporate and retail on one carrier', async () => {
    const c = await newSession();
    const res = await search(c);
    const corp = res.offers.find((o: any) => o.carrier === '6E' && o.fareType === 'CORPORATE');
    const retail = res.offers.find((o: any) => o.carrier === '6E' && o.fareType === 'RETAIL');

    const r = await c.post('/api/cart/validate', { offerIds: [corp.id, retail.id] });
    expect(r.status).toBe(409);
    expect(r.body.constraintRef).toBe('CON-1');

    // …and the hold route enforces it too, so there is no way around it.
    const h = await c.post('/api/holds', { offerIds: [corp.id, retail.id] });
    expect(h.status).toBe(409);
    expect(h.body.constraintRef).toBe('CON-1');
  });

  it('CON-13: rejects card data on ANY route, before the handler runs', async () => {
    const c = await newSession();

    for (const payload of [
      { cardNumber: '4111111111111111' },
      { cvv: '123' },
      { nested: { memo: '4111 1111 1111 1111' } },
    ]) {
      const r = await c.post('/api/holds', { offerIds: ['x'], ...payload });
      expect(r.status).toBe(400);
      expect(r.body.constraintRef).toBe('CON-13');
    }

    // A route that has nothing to do with payment is still protected.
    const s = await c.post('/api/search', { origin: 'DEL', destination: 'BOM', departDate: dateIn(30), cvv: '999' });
    expect(s.status).toBe(400);
    expect(s.body.constraintRef).toBe('CON-13');
  });

  it('CON-13: refuses a payment token that is actually a card number', async () => {
    const c = await newSession();
    const res = await search(c);
    const hold = await c.post('/api/holds', { offerIds: [compliantCorporate(res).id] });

    const r = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: 'tok_4111111111111111',
      allocation: ALLOC,
    });
    expect(r.status).toBe(400);
    expect(r.body.constraintRef).toBe('CON-13');
  });

  it('FR-GST-1: blocks booking when the configured GSTIN is invalid', async () => {
    const c = await newSession();
    const res = await search(c);
    const hold = await c.post('/api/holds', { offerIds: [compliantCorporate(res).id] });

    // Corrupt the stored entity behind the API's back.
    const org = store.getOrganisation();
    org.legalEntities[0]!.gstin = 'NOTVALID';
    store.setOrganisation(org);

    const r = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
    });
    expect(r.status).toBe(422);
    expect(r.body.constraintRef).toBe('FR-GST-1');
  });

  it('CON-10: requires a session to search or book', async () => {
    const anon = new Client();
    const r = await anon.post('/api/search', { origin: 'DEL', destination: 'BOM', departDate: dateIn(30) });
    expect(r.status).toBe(401);
    expect(r.body.constraintRef).toBe('CON-10');
  });

  it('CON-12: refuses to book against an expired hold', async () => {
    const c = await newSession();
    const res = await search(c);
    const hold = await c.post('/api/holds', { offerIds: [compliantCorporate(res).id] });

    // Age the hold past its 5-minute window.
    const stored = store.getHold(hold.body.hold.id)!;
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    store.putHold(stored);

    const r = await c.post('/api/bookings', {
      holdId: stored.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
    });
    expect(r.status).toBe(409);
    expect(r.body.constraintRef).toBe('CON-12');
  });
});

describe('E2E — policy and allocation gates', () => {
  it('hard-blocks premium cabin and refuses to let it be justified away', async () => {
    const c = await newSession();
    const res = await search(c, { cabin: 'PREMIUM' });
    expect(res.offers.every((o: any) => o.policy.blocked)).toBe(true);

    const hold = await c.post('/api/holds', { offerIds: [res.offers[0].id] });
    const r = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      policyJustification: 'the client insisted',
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('POLICY_BLOCKED');
  });

  it('allows a soft breach with a justification and records it', async () => {
    const c = await newSession();
    const res = await search(c, { departDate: dateIn(2) });
    const offer = res.offers.find((o: any) => o.fareType === 'CORPORATE' && !o.policy.compliant && !o.policy.blocked);
    expect(offer).toBeDefined();

    const hold = await c.post('/api/holds', { offerIds: [offer.id] });

    const refused = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      idempotencyKey: 'e2e_soft_1',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('POLICY_JUSTIFICATION_REQUIRED');

    const ok = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      policyJustification: 'Client escalation required same-week travel',
      idempotencyKey: 'e2e_soft_2',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.booking.policyJustification).toContain('Client escalation');

    const compliance = await c.get('/api/reports/compliance');
    expect(compliance.body.outOfPolicy).toBe(1);
    expect(compliance.body.justifications[0].reason).toContain('Client escalation');
  });

  it('rejects an unknown or inactive project code', async () => {
    const c = await newSession();
    const res = await search(c);
    const hold = await c.post('/api/holds', { offerIds: [compliantCorporate(res).id] });

    const bad = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: { ...ALLOC, projectCode: 'PRJ-DOESNOTEXIST' },
    });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toContain('Active project');
  });

  it('requires an allocation at all', async () => {
    const c = await newSession();
    const res = await search(c);
    const hold = await c.post('/api/holds', { offerIds: [compliantCorporate(res).id] });

    const r = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });
});

describe('E2E — resilience', () => {
  it('never presents a failed corporate query as "no corporate fare"', async () => {
    const c = await newSession();
    await c.post('/api/mock/control', {
      action: 'failLeg',
      carrier: '6E',
      fareScope: 'CORPORATE',
      failure: 'AUTH_FAILURE',
    });

    const res = await search(c);
    expect(res.corporateUnavailableDueToFailure).toBe(true);
    const leg = res.legs.find((l: any) => l.carrier === '6E' && l.fareType === 'CORPORATE');
    expect(leg.outcome).toBe('AUTH_FAILURE');
    expect(leg.outcome).not.toBe('NO_INVENTORY');

    // Retail for that carrier still renders.
    expect(res.offers.some((o: any) => o.carrier === '6E' && o.fareType === 'RETAIL')).toBe(true);

    // And an admin is told.
    const alerts = await c.get('/api/admin/alerts');
    expect(alerts.body.alerts.some((a: any) => a.code === 'CORPORATE_LEG_AUTH_FAILURE')).toBe(true);
  });

  it('halts on a price change, then books at the accepted price', async () => {
    const c = await newSession();
    const res = await search(c);
    const offer = compliantCorporate(res);
    const hold = await c.post('/api/holds', { offerIds: [offer.id] });
    await c.post('/api/mock/control', { action: 'priceDelta', delta: 0.08 });

    const halted = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      idempotencyKey: 'e2e_price_1',
    });
    expect(halted.status).toBe(409);
    expect(halted.body.constraintRef).toBe('FR-BOOK-5');
    const newTotal = halted.body.detail.newTotal;
    expect(newTotal).toBeGreaterThan(offer.price.total);

    const ok = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      acceptedTotal: newTotal,
      idempotencyKey: 'e2e_price_2',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.booking.offer.price.total).toBe(newTotal);
  });

  it('issues exactly one ticket when the response is lost and the client retries', async () => {
    const c = await newSession();
    const res = await search(c);
    const hold = await c.post('/api/holds', { offerIds: [compliantCorporate(res).id] });
    await c.post('/api/mock/control', { action: 'dropBookResponse' });

    const payload = {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      idempotencyKey: 'e2e_chaos_1',
    };

    const first = await c.post('/api/bookings', payload);
    expect(first.status).toBe(502);
    expect(first.body.code).toBe('BOOKING_INDETERMINATE');

    const pnrs = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const retry = await c.post('/api/bookings', payload);
      expect(retry.status).toBe(200);
      pnrs.add(retry.body.booking.pnr);
    }
    expect(pnrs.size).toBe(1);
    expect(store.listBookings()).toHaveLength(1);
  });

  it('refuses a name change with a 501 and an explanation', async () => {
    const c = await newSession();
    const res = await search(c);
    const hold = await c.post('/api/holds', { offerIds: [compliantCorporate(res).id] });
    const b = await c.post('/api/bookings', {
      holdId: hold.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      idempotencyKey: 'e2e_name_1',
    });

    const r = await c.post(`/api/bookings/${b.body.booking.id}/name-change`);
    expect(r.status).toBe(501);
    expect(r.body.constraintRef).toBe('FR-SVC-4');
  });

  it('returns 404 for an unknown booking reference rather than leaking data', async () => {
    const c = await newSession();
    const r = await c.get('/api/bookings/reference/CFB-XXXXXX');
    expect(r.status).toBe(404);
  });

  it('rejects a nonsense search rather than guessing', async () => {
    const c = await newSession();
    const same = await c.post('/api/search', {
      origin: 'DEL',
      destination: 'DEL',
      departDate: dateIn(10),
    });
    expect(same.status).toBe(400);

    const bad = await c.post('/api/search', { origin: 'D', destination: 'BOM', departDate: dateIn(10) });
    expect(bad.status).toBe(400);
  });
});

describe('E2E — admin configuration takes effect without a deploy', () => {
  it('removing a carrier config removes its corporate fares from the next search', async () => {
    const c = await newSession();
    const before = await search(c);
    expect(before.offers.some((o: any) => o.carrier === 'QP' && o.fareType === 'CORPORATE')).toBe(true);

    const del = await c.del('/api/admin/corporate-fare-configs/QP');
    expect(del.status).toBe(200);

    const after = await search(c);
    expect(after.offers.some((o: any) => o.carrier === 'QP' && o.fareType === 'CORPORATE')).toBe(false);
    // Retail for that carrier is unaffected.
    expect(after.offers.some((o: any) => o.carrier === 'QP' && o.fareType === 'RETAIL')).toBe(true);
  });

  it('adding a config makes corporate fares appear immediately (CON-7)', async () => {
    const c = await newSession();
    await c.del('/api/admin/corporate-fare-configs/SG');
    expect((await search(c)).offers.some((o: any) => o.carrier === 'SG' && o.fareType === 'CORPORATE')).toBe(false);

    const put = await c.put('/api/admin/corporate-fare-configs/SG', {
      mechanism: 'PROMO_CODE',
      credentialRef: 'secret://supply/spicejet/new',
      code: 'SGNEW2026',
      activeFrom: '2026-01-01',
    });
    expect(put.status).toBe(200);

    const after = await search(c);
    const sg = after.offers.find((o: any) => o.carrier === 'SG' && o.fareType === 'CORPORATE');
    expect(sg).toBeDefined();
    expect(sg.corporateProof.mechanism).toBe('PROMO_CODE');
  });

  it('rejects a code-based mechanism with no retrieval code (CON-3)', async () => {
    const c = await newSession();
    const r = await c.put('/api/admin/corporate-fare-configs/AI', {
      mechanism: 'ACCOUNT_CODE',
      credentialRef: 'secret://x',
      tourCode: 'TOURONLY',
      activeFrom: '2026-01-01',
    });
    expect(r.status).toBe(422);
    expect(r.body.constraintRef).toBe('CON-3');
  });

  it('rejects an invalid GSTIN and a state-code mismatch (FR-ORG-1)', async () => {
    const c = await newSession();

    const bad = await c.put('/api/admin/legal-entities/le_karnataka', {
      name: 'X',
      gstin: 'BROKEN',
      registeredName: 'X',
      stateCode: '29',
      invoiceEmail: 'a@consultco.example',
      address: 'x',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('INVALID_GSTIN');

    const mismatch = await c.put('/api/admin/legal-entities/le_karnataka', {
      name: 'X',
      gstin: '29AABCC1234D1Z5',
      registeredName: 'X',
      stateCode: '27',
      invoiceEmail: 'a@consultco.example',
      address: 'x',
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('GSTIN_STATE_MISMATCH');
  });

  it('never exposes a resolved credential through the config API', async () => {
    const c = await newSession();
    const pub = await c.get('/api/config');
    const admin = await c.get('/api/admin/config');
    for (const payload of [pub.body, admin.body]) {
      const s = JSON.stringify(payload);
      expect(s).toContain('secret://');
      expect(s).not.toMatch(/password|apikey|api_key|bearer /i);
    }
  });
});

describe('E2E — reporting reflects what actually happened', () => {
  it('reports attach rates, savings and a GSTR-2B ledger after real bookings', async () => {
    const c = await newSession();

    // One corporate booking.
    const res1 = await search(c);
    const h1 = await c.post('/api/holds', { offerIds: [compliantCorporate(res1).id] });
    await c.post('/api/bookings', {
      holdId: h1.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      idempotencyKey: 'e2e_rpt_1',
    });

    // One retail booking that declines a corporate fare.
    const res2 = await search(c, { destination: 'BLR' });
    const retail = res2.offers.find(
      (o: any) => o.fareType === 'RETAIL' && o.corporateAlternativeId && o.policy.compliant,
    );
    const h2 = await c.post('/api/holds', { offerIds: [retail.id] });
    await c.post('/api/bookings', {
      holdId: h2.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: { projectCode: 'PRJ-0001', costCentreCode: 'CC-INT', clientBillable: false },
      retailOverCorporateReason: 'timing',
      idempotencyKey: 'e2e_rpt_2',
    });

    const dash = (await c.get('/api/reports/dashboard')).body;
    expect(dash.attach.corporateAttachRate).toBe(0.5);
    expect(dash.attach.gstinAttachRate).toBe(1);
    expect(dash.attach.declinedCorporate).toBe(1);
    expect(dash.attach.forgoneSaving).toBeGreaterThan(0);
    expect(dash.savings.totalSaving).toBeGreaterThan(0);
    expect(dash.headlines.join(' ')).toMatch(/declined an available corporate fare/);

    const spend = (await c.get('/api/reports/spend')).body;
    expect(spend.byProject).toHaveLength(2);
    expect(spend.clientBillable).toHaveLength(2);

    const csvRes = await fetch(`${base}/api/reports/gstr2b?format=csv`);
    expect(csvRes.headers.get('content-type')).toContain('text/csv');
    const csv = await csvRes.text();
    const rows = csv.trim().split('\n');
    expect(rows[0]).toContain('supplier_gstin');
    // 2 bookings x 2 invoices each.
    expect(rows).toHaveLength(5);
    expect(csv).toContain('AIRLINE_FARE');
    expect(csv).toContain('AGENT_SERVICE_FEE');
  });

  it('savings reconcile: net + ITC === paid, across the whole ledger', async () => {
    const c = await newSession();
    const res = await search(c);
    const h = await c.post('/api/holds', { offerIds: [compliantCorporate(res).id] });
    await c.post('/api/bookings', {
      holdId: h.body.hold.id,
      passengers: PAX,
      paymentToken: await token(c),
      allocation: ALLOC,
      idempotencyKey: 'e2e_recon',
    });

    const s = (await c.get('/api/reports/dashboard')).body.savings;
    expect(s.netCost + s.itcRecoverable).toBe(s.totalPayable);
  });
});

describe('E2E — the web app is actually served', () => {
  it('serves the built UI at the root', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain('ConsultCo Travel');
  });

  it('serves the JS bundle', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(m).toBeTruthy();
    const js = await fetch(`${base}${m![1]}`);
    expect(js.status).toBe(200);
  });

  it('reports health', async () => {
    const r = await (await fetch(`${base}/api/health`)).json();
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('mock');
  });
});
