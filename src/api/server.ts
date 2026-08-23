import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { store } from '../store/store.js';
import { seed } from '../store/seed.js';
import { MockAdapter } from '../supply/mock/MockAdapter.js';
import { mockControl } from '../supply/mock/control.js';
import { SearchOrchestrator } from '../search/orchestrator.js';
import { BookingService } from '../booking/bookingService.js';
import { ServicingService } from '../booking/servicing.js';
import { assertNoMixedFareTypes, cartTotals } from '../booking/cart.js';
import { createHold, remainingMs, requireLiveHold } from '../booking/hold.js';
import { assertNoCardData, issueMockToken } from '../booking/payment.js';
import { checkPlaceOfSupply } from '../gst/gate.js';
import { DomainError, NotFoundError } from '../domain/errors.js';
import { id } from '../domain/ids.js';
import { AIRPORTS } from '../supply/mock/fixtures.js';
import { dashboard } from '../reporting/metrics.js';
import { complianceReport, gstr2bCsv, gstr2bLines, spendReport } from '../reporting/finance.js';
import { validateGstin } from '../domain/gstin.js';
import type { FareOffer, Session } from '../domain/types.js';

const provider = new MockAdapter();
const bookingService = new BookingService(provider);
const servicingService = new ServicingService(provider);

/** Offers from recent searches, so a hold can be created by offer id. */
const offerCache = new Map<string, { offer: FareOffer; at: number }>();
const OFFER_TTL_MS = 30 * 60 * 1000;

function cacheOffers(offers: FareOffer[]): void {
  const now = Date.now();
  for (const o of offers) offerCache.set(o.id, { offer: o, at: now });
  for (const [k, v] of offerCache) if (now - v.at > OFFER_TTL_MS) offerCache.delete(k);
}

const app = express();
app.use(express.json({ limit: '256kb' }));

/**
 * CON-13 — card data must never reach this server.
 *
 * Applied globally and BEFORE any route handler, so there is no endpoint that
 * can accidentally accept a PAN. The request is rejected, not sanitised: by the
 * time we could strip a field the data has already been received.
 */
app.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    try {
      assertNoCardData(req.body);
    } catch (err) {
      return next(err);
    }
  }
  next();
});

// --- session (CON-10) --------------------------------------------------------

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function currentSession(req: Request): Session | undefined {
  const sid = readCookie(req, 'sid');
  if (!sid) return undefined;
  const s = store.getSession(sid);
  if (!s) return undefined;
  if (new Date(s.expiresAt).getTime() < Date.now()) return undefined;
  return s;
}

function requireSession(req: Request): Session {
  const s = currentSession(req);
  if (!s) {
    throw new DomainError(
      'No active session. Start a session before searching or booking.',
      'NO_SESSION',
      'CON-10',
      401,
    );
  }
  return s;
}

function requireEntity(session: Session) {
  const entity = store.getLegalEntity(session.legalEntityId);
  if (!entity) throw new NotFoundError('Legal entity', session.legalEntityId);
  return entity;
}

// --- routes ------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, provider: provider.name, stage: '1-2' });
});

app.get('/api/config', (_req, res) => {
  const org = store.getOrganisation();
  res.json({
    organisation: { id: org.id, name: org.name },
    legalEntities: org.legalEntities.map((e) => ({
      id: e.id,
      name: e.name,
      gstin: e.gstin,
      registeredName: e.registeredName,
      stateCode: e.stateCode,
    })),
    corporateFareConfigs: org.corporateFareConfigs.map((c) => ({
      carrier: c.carrier,
      mechanism: c.mechanism,
      // Never expose the credential itself (FR-ORG-3, NFR-6).
      credentialRef: c.credentialRef,
      hasCode: Boolean(c.code),
      hasTourCode: Boolean(c.tourCode),
    })),
    gstRates: org.gstRates,
    rankingPolicy: org.rankingPolicy,
    costCentres: org.costCentres.filter((c) => c.active),
    projects: org.projects.filter((p) => p.active),
    policies: org.policies,
    airports: AIRPORTS,
  });
});

app.post('/api/session', (req, res) => {
  const body = z.object({ legalEntityId: z.string().optional() }).parse(req.body ?? {});
  const org = store.getOrganisation();
  const entityId = body.legalEntityId ?? org.legalEntities[0]!.id;
  if (!store.getLegalEntity(entityId)) throw new NotFoundError('Legal entity', entityId);

  const now = Date.now();
  const session: Session = {
    id: id('sess'),
    legalEntityId: entityId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  store.putSession(session);
  res.cookie?.('sid', session.id, { httpOnly: true, sameSite: 'lax' });
  res.setHeader('Set-Cookie', `sid=${session.id}; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ session, entity: store.getLegalEntity(entityId) });
});

app.get('/api/session', (req, res) => {
  const s = currentSession(req);
  if (!s) return res.status(404).json({ error: 'No active session' });
  res.json({ session: s, entity: store.getLegalEntity(s.legalEntityId) });
});

const searchSchema = z.object({
  origin: z.string().length(3),
  destination: z.string().length(3),
  departDate: z.string(),
  returnDate: z.string().optional(),
  passengers: z.number().int().min(1).max(9).default(1),
  cabin: z.enum(['ECONOMY', 'PREMIUM']).default('ECONOMY'),
});

app.post('/api/search', async (req, res, next) => {
  try {
    requireSession(req);
    const criteria = searchSchema.parse(req.body);
    if (criteria.origin === criteria.destination) {
      throw new DomainError('Origin and destination must differ', 'BAD_ROUTE', '-', 400);
    }
    const org = store.getOrganisation();
    const orchestrator = new SearchOrchestrator(provider, org);
    const result = await orchestrator.search(criteria);
    cacheOffers(result.offers);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** CON-1 demonstration endpoint — validates a proposed cart before anything is held. */
app.post('/api/cart/validate', (req, res, next) => {
  try {
    requireSession(req);
    const { offerIds } = z.object({ offerIds: z.array(z.string()).min(1) }).parse(req.body);
    const offers = offerIds.map((oid) => {
      const hit = offerCache.get(oid);
      if (!hit) throw new NotFoundError('Offer', oid);
      return hit.offer;
    });
    assertNoMixedFareTypes(offers); // CON-1
    res.json({ valid: true, totals: cartTotals(offers) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/holds', (req, res, next) => {
  try {
    const session = requireSession(req);
    const { offerIds } = z.object({ offerIds: z.array(z.string()).min(1) }).parse(req.body);
    const offers = offerIds.map((oid) => {
      const hit = offerCache.get(oid);
      if (!hit) throw new NotFoundError('Offer', oid);
      return hit.offer;
    });
    assertNoMixedFareTypes(offers); // CON-1, before a hold exists

    const entity = requireEntity(session);
    const hold = createHold(offers[0]!, session.id);
    res.json({
      hold,
      remainingMs: remainingMs(hold),
      placeOfSupply: checkPlaceOfSupply(entity, offers[0]!.segments),
      gstPreview: {
        gstin: entity.gstin,
        legalName: entity.registeredName,
        // FR-GST-2: pre-filled, never traveller-entered.
        editable: false,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/holds/:id', (req, res, next) => {
  try {
    const hold = store.getHold(req.params.id);
    if (!hold) throw new NotFoundError('Fare hold', req.params.id);
    res.json({ hold, remainingMs: remainingMs(hold), expired: remainingMs(hold) <= 0 });
  } catch (err) {
    next(err);
  }
});

/** Mock tokenisation — stands in for the provider's client-side SDK (CON-13). */
app.post('/api/payment/token', (_req, res) => {
  res.json({ token: issueMockToken() });
});

const passengerSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(6),
  dateOfBirth: z.string().optional(),
});

app.post('/api/bookings', async (req, res, next) => {
  try {
    const session = requireSession(req);
    const entity = requireEntity(session);
    const body = z
      .object({
        holdId: z.string(),
        passengers: z.array(passengerSchema).min(1),
        paymentToken: z.string(),
        acceptedTotal: z.number().optional(),
        idempotencyKey: z.string().min(8).optional(),
        // FR-DISP-4 — required when declining an available corporate fare.
        retailOverCorporateReason: z.string().min(3).optional(),
        // FR-BOOK-1 — allocation is mandatory.
        allocation: z.object({
          projectCode: z.string().min(1),
          costCentreCode: z.string().min(1),
          clientBillable: z.boolean(),
        }),
        // FR-POL-3 — required on a soft policy breach.
        policyJustification: z.string().min(3).optional(),
      })
      .parse(req.body);

    // FR-ORG-4 — allocation codes must exist and be active, or the spend
    // report and the client rebill are built on free text.
    const org = store.getOrganisation();
    const project = org.projects.find((p) => p.code === body.allocation.projectCode && p.active);
    const costCentre = org.costCentres.find(
      (c) => c.code === body.allocation.costCentreCode && c.active,
    );
    if (!project) throw new NotFoundError('Active project', body.allocation.projectCode);
    if (!costCentre) throw new NotFoundError('Active cost centre', body.allocation.costCentreCode);

    const idempotencyKey =
      body.idempotencyKey ?? (req.header('Idempotency-Key') || `idem_${randomUUID()}`);

    const { booking, replayed } = await bookingService.book({
      holdId: body.holdId,
      session,
      entity,
      passengers: body.passengers,
      paymentToken: body.paymentToken,
      ...(body.acceptedTotal !== undefined ? { acceptedTotal: body.acceptedTotal } : {}),
      ...(body.retailOverCorporateReason
        ? { retailOverCorporateReason: body.retailOverCorporateReason }
        : {}),
      allocation: body.allocation,
      ...(body.policyJustification ? { policyJustification: body.policyJustification } : {}),
      idempotencyKey,
    });

    res.json({ booking, replayed });
  } catch (err) {
    next(err);
  }
});

app.get('/api/bookings', (req, res, next) => {
  try {
    const session = requireSession(req);
    res.json({ bookings: store.listBookingsForSession(session.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Retrieval by reference — Stage 2.
 *
 * Closes the CON-10 hole: bookings are session-scoped, so a closed browser tab
 * would otherwise strand a booking nobody can reach.
 */
app.get('/api/bookings/reference/:reference', (req, res, next) => {
  try {
    const booking = store.getBookingByReference(req.params.reference);
    if (!booking) throw new NotFoundError('Booking', req.params.reference);
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

app.get('/api/bookings/:id', (req, res, next) => {
  try {
    const booking = store.getBooking(req.params.id);
    if (!booking) throw new NotFoundError('Booking', req.params.id);
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

app.get('/api/bookings/:id/cancellation-quote', async (req, res, next) => {
  try {
    res.json(await servicingService.quoteCancellation(req.params.id));
  } catch (err) {
    next(err);
  }
});

app.post('/api/bookings/:id/cancel', async (req, res, next) => {
  try {
    const session = requireSession(req);
    res.json({ booking: await servicingService.cancel(req.params.id, session.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/bookings/:id/change-quote', async (req, res, next) => {
  try {
    res.json(await servicingService.quoteChange(req.params.id));
  } catch (err) {
    next(err);
  }
});

app.post('/api/bookings/:id/name-change', (req, res, next) => {
  try {
    servicingService.requestNameChange(req.params.id); // FR-SVC-4 — always 501
  } catch (err) {
    next(err);
  }
});

// --- admin (Stage 2 operational visibility) ----------------------------------

app.get('/api/admin/alerts', (req, res) => {
  const includeAck = req.query['all'] === 'true';
  res.json({ alerts: store.listAlerts(includeAck) });
});

app.post('/api/admin/alerts/:id/acknowledge', (req, res) => {
  store.acknowledgeAlert(req.params.id);
  res.json({ ok: true });
});

/**
 * Reporting dashboard — FR-RPT-1, FR-RPT-2, FR-RPT-3, FR-RPT-6, FR-SVC-3.
 *
 * Every figure is computed from stored booking evidence, never from a vendor
 * percentage: research.md §6.2 found no credible published discount figure for
 * Indian corporate fares, so the only number worth trusting is the observed one.
 */
app.get('/api/reports/dashboard', (_req, res) => {
  res.json(dashboard(store.listBookings(), store.listLegTelemetry()));
});

app.get('/api/admin/leg-health', (_req, res) => {
  const d = dashboard(store.listBookings(), store.listLegTelemetry());
  res.json({ legs: d.legs, sampleCount: store.listLegTelemetry().length });
});

// --- Stage 4: finance & compliance reporting -------------------------------

/** FR-RPT-4 — spend by project, cost centre and billability. */
app.get('/api/reports/spend', (_req, res) => {
  res.json(spendReport(store.listBookings(), store.getOrganisation()));
});

/** FR-RPT-5 — policy compliance rate and recorded justifications. */
app.get('/api/reports/compliance', (_req, res) => {
  res.json(complianceReport(store.listBookings()));
});

/** FR-GST-6 — a ledger finance reconciles line-by-line against GSTR-2B. */
app.get('/api/reports/gstr2b', (req, res) => {
  const lines = gstr2bLines(store.listBookings());
  if (req.query['format'] === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="gstr2b-reconciliation.csv"');
    return res.send(gstr2bCsv(lines));
  }
  res.json({ lines, count: lines.length });
});

// --- Stage 4: admin configuration (FR-ORG-1, FR-ORG-2, FR-ORG-4) -----------

/**
 * Config is editable by a travel admin without an engineer or a deploy — the
 * point of Stage 4. CON-7 in particular: a new carrier corporate code must be
 * a config change, because both the supply partner (DEC-1) and the sourcing
 * model (DEC-3) are still open.
 *
 * NOTE (CON-10): there is no auth in v1, so these routes are unprotected.
 * They must be role-gated when identity lands in Stage 6.
 */
app.get('/api/admin/config', (_req, res) => {
  const org = store.getOrganisation();
  res.json({
    organisation: { id: org.id, name: org.name },
    legalEntities: org.legalEntities,
    corporateFareConfigs: org.corporateFareConfigs,
    costCentres: org.costCentres,
    projects: org.projects,
    policies: org.policies,
    gstRates: org.gstRates,
    rankingPolicy: org.rankingPolicy,
    serviceFeePerBooking: org.serviceFeePerBooking,
  });
});

const legalEntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gstin: z.string(),
  registeredName: z.string().min(1),
  stateCode: z.string().length(2),
  invoiceEmail: z.string().email(),
  address: z.string().min(1),
});

app.put('/api/admin/legal-entities/:id', (req, res, next) => {
  try {
    const entity = legalEntitySchema.parse({ ...req.body, id: req.params.id });
    // FR-ORG-1 — positional GSTIN validation at entry, because it cannot be
    // corrected after a ticket is issued (CON-4).
    const v = validateGstin(entity.gstin);
    if (!v.valid) {
      throw new DomainError('Invalid GSTIN', 'INVALID_GSTIN', 'FR-ORG-1', 422, { errors: v.errors });
    }
    if (v.stateCode !== entity.stateCode) {
      throw new DomainError(
        `GSTIN state prefix ${v.stateCode} does not match the declared state code ${entity.stateCode}.`,
        'GSTIN_STATE_MISMATCH',
        'FR-ORG-1',
        422,
      );
    }
    const org = store.getOrganisation();
    const idx = org.legalEntities.findIndex((e) => e.id === entity.id);
    if (idx >= 0) org.legalEntities[idx] = entity;
    else org.legalEntities.push(entity);
    store.setOrganisation(org);
    res.json({ legalEntity: entity });
  } catch (err) {
    next(err);
  }
});

const corporateConfigSchema = z.object({
  carrier: z.enum(['6E', 'AI', 'QP', 'SG']),
  mechanism: z.enum(['CREDENTIAL', 'ACCOUNT_CODE', 'PROMO_CODE', 'CONTRACT_CODE']),
  credentialRef: z.string().min(1),
  code: z.string().optional(),
  tourCode: z.string().optional(),
  activeFrom: z.string(),
  activeTo: z.string().optional(),
});

app.put('/api/admin/corporate-fare-configs/:carrier', (req, res, next) => {
  try {
    const cfg = corporateConfigSchema.parse({ ...req.body, carrier: req.params.carrier });
    // CON-3: the search-time code and the ticket-time tour code are different
    // things. A non-credential mechanism cannot retrieve anything without a code.
    if (cfg.mechanism !== 'CREDENTIAL' && !cfg.code) {
      throw new DomainError(
        `Mechanism ${cfg.mechanism} needs a retrieval code; a tour code will not unlock a fare.`,
        'MISSING_RETRIEVAL_CODE',
        'CON-3',
        422,
      );
    }
    const org = store.getOrganisation();
    const idx = org.corporateFareConfigs.findIndex((c) => c.carrier === cfg.carrier);
    if (idx >= 0) org.corporateFareConfigs[idx] = cfg;
    else org.corporateFareConfigs.push(cfg);
    store.setOrganisation(org);
    res.json({ corporateFareConfig: cfg });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/admin/corporate-fare-configs/:carrier', (req, res) => {
  const org = store.getOrganisation();
  org.corporateFareConfigs = org.corporateFareConfigs.filter((c) => c.carrier !== req.params.carrier);
  store.setOrganisation(org);
  res.json({ ok: true });
});

app.put('/api/admin/projects/:code', (req, res, next) => {
  try {
    const project = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        clientName: z.string().min(1),
        clientBillable: z.boolean(),
        active: z.boolean(),
      })
      .parse({ ...req.body, code: req.params.code });
    const org = store.getOrganisation();
    const idx = org.projects.findIndex((p) => p.code === project.code);
    if (idx >= 0) org.projects[idx] = project;
    else org.projects.push(project);
    store.setOrganisation(org);
    res.json({ project });
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/cost-centres/:code', (req, res, next) => {
  try {
    const cc = z
      .object({ code: z.string().min(1), name: z.string().min(1), active: z.boolean() })
      .parse({ ...req.body, code: req.params.code });
    const org = store.getOrganisation();
    const idx = org.costCentres.findIndex((c) => c.code === cc.code);
    if (idx >= 0) org.costCentres[idx] = cc;
    else org.costCentres.push(cc);
    store.setOrganisation(org);
    res.json({ costCentre: cc });
  } catch (err) {
    next(err);
  }
});

/** FR-POL-2 / FR-POL-3 — the default policy is admin-editable. */
app.put('/api/admin/policies/:id', (req, res, next) => {
  try {
    const policy = z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        isDefault: z.boolean(),
        rules: z.array(z.any()),
      })
      .parse({ ...req.body, id: req.params.id });
    const org = store.getOrganisation();
    const idx = org.policies.findIndex((p) => p.id === policy.id);
    if (idx >= 0) org.policies[idx] = policy as never;
    else org.policies.push(policy as never);
    store.setOrganisation(org);
    res.json({ policy });
  } catch (err) {
    next(err);
  }
});

/** Failure injection, so Stage 2 behaviour can actually be demonstrated. */
app.post('/api/mock/control', (req, res) => {
  const body = z
    .object({
      action: z.enum(['failLeg', 'priceDelta', 'dropBookResponse', 'latency', 'reset']),
      carrier: z.enum(['6E', 'AI', 'QP', 'SG']).optional(),
      fareScope: z.enum(['RETAIL', 'CORPORATE']).optional(),
      failure: z
        .enum(['AUTH_FAILURE', 'TIMEOUT', 'NO_INVENTORY', 'MISCONFIGURED', 'PROVIDER_ERROR'])
        .optional(),
      delta: z.number().optional(),
      ms: z.number().optional(),
    })
    .parse(req.body);

  switch (body.action) {
    case 'failLeg':
      mockControl.failLeg({
        ...(body.carrier ? { carrier: body.carrier } : {}),
        ...(body.fareScope ? { fareScope: body.fareScope } : {}),
        failure: body.failure ?? 'AUTH_FAILURE',
      });
      break;
    case 'priceDelta':
      mockControl.setPriceDelta(body.delta ?? 0.08);
      break;
    case 'dropBookResponse':
      mockControl.armDroppedBookResponse();
      break;
    case 'latency':
      mockControl.setLatency(body.ms ?? 0);
      break;
    case 'reset':
      mockControl.reset();
      break;
  }
  res.json({ ok: true, state: mockControl.describe() });
});

// --- static web --------------------------------------------------------------

const webDist = resolve(process.cwd(), 'dist', 'web');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

// --- error handling ----------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof DomainError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      // Surfacing the constraint makes a rejection traceable to the rule that
      // caused it, rather than an opaque 400.
      constraintRef: err.constraintRef,
      detail: err.detail,
    });
  }
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION', detail: err.issues });
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  console.error('[unhandled]', err);
  res.status(500).json({ error: message, code: 'INTERNAL' });
});

const PORT = Number(process.env['PORT'] ?? 3000);

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    store.getOrganisation();
  } catch {
    seed();
    console.log('No organisation configured — seeded defaults.');
  }
  app.listen(PORT, () => {
    console.log(`Corporate flight booking API on http://localhost:${PORT}`);
    console.log(`Provider: ${provider.name} (DEC-1 unresolved — mock supply)`);
  });
}

export { app, provider, bookingService, servicingService, offerCache, cacheOffers };
