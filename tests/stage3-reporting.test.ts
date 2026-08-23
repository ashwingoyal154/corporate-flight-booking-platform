import { beforeEach, describe, expect, it } from 'vitest';
import { attachRates, creditShells, dashboard, legHealth, savingsSummary } from '../src/reporting/metrics.js';
import { buildInvoices, totalRecoverableItc } from '../src/gst/invoices.js';
import { BookingService } from '../src/booking/bookingService.js';
import { ServicingService } from '../src/booking/servicing.js';
import { createHold } from '../src/booking/hold.js';
import { issueMockToken } from '../src/booking/payment.js';
import { store } from '../src/store/store.js';
import { rupees } from '../src/domain/money.js';
import { criteria, entityFor, makeSession, newOrchestrator, PASSENGER, resetWorld, ALLOCATION, pickBookable} from './helpers.js';
import type { Booking, FareType } from '../src/domain/types.js';

/**
 * Stage 3 reporting — FR-RPT-1/2/3/6, FR-SVC-3, FR-GST-4.
 *
 * research.md §6.2 found no credible published figure for the realised discount
 * on an Indian corporate fare. These metrics exist so the client measures their
 * own number instead of trusting a vendor's.
 */
async function bookOne(opts: { fareType: FareType; reason?: string; key: string }) {
  const { provider, orchestrator } = newOrchestrator();
  const session = makeSession();
  const entity = entityFor(session);
  const result = await orchestrator.search(criteria());
  const offer = pickBookable(result, {
    fareType: opts.fareType,
    needsCorporateAlternative: opts.fareType === 'RETAIL',
  });
  const hold = createHold(offer, session.id);
  const { booking } = await new BookingService(provider).book({
    holdId: hold.id,
    session,
    entity,
    passengers: [PASSENGER],
    paymentToken: issueMockToken(),
    allocation: ALLOCATION,
    ...(opts.reason ? { retailOverCorporateReason: opts.reason } : {}),
    idempotencyKey: opts.key,
  });
  return { booking, session, provider };
}

describe('FR-RPT-1 — corporate fare attach rate', () => {
  beforeEach(resetWorld);

  it('is null with no eligible bookings, rather than a misleading zero', () => {
    expect(attachRates([]).corporateAttachRate).toBeNull();
  });

  it('is 100% when the corporate fare is taken', async () => {
    await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    const a = attachRates(store.listBookings());
    expect(a.corporateAttachRate).toBe(1);
    expect(a.corporateBookings).toBe(1);
  });

  it('drops when a corporate fare is available and declined', async () => {
    await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    await bookOne({ fareType: 'RETAIL', reason: 'schedule', key: 'k2' });

    const a = attachRates(store.listBookings());
    expect(a.corporateEligibleBookings).toBe(2);
    expect(a.corporateAttachRate).toBe(0.5);
    expect(a.declinedCorporate).toBe(1);
    expect(a.forgoneSaving).toBeGreaterThan(0);
  });

  it('excludes routes with no corporate inventory from the denominator', async () => {
    // Otherwise the metric measures network coverage, not traveller behaviour.
    const org = store.getOrganisation();
    org.corporateFareConfigs = [];
    store.setOrganisation(org);

    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const hold = createHold(pickBookable(result, { fareType: 'RETAIL' }), session.id);
    await new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'k_nocorp',
    });

    const a = attachRates(store.listBookings());
    expect(a.totalBookings).toBe(1);
    expect(a.corporateEligibleBookings).toBe(0);
    expect(a.corporateAttachRate).toBeNull();
  });

  it('ignores cancelled bookings', async () => {
    const { booking, session, provider } = await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    await new ServicingService(provider).cancel(booking.id, session.id);
    expect(attachRates(store.listBookings()).totalBookings).toBe(0);
  });
});

describe('FR-RPT-2 — GSTIN attach rate', () => {
  beforeEach(resetWorld);

  it('is 100% because booking without a GSTIN is impossible', async () => {
    await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    await bookOne({ fareType: 'RETAIL', reason: 'timing', key: 'k2' });
    const a = attachRates(store.listBookings());
    expect(a.gstinAttachRate).toBe(1);
    expect(a.bookingsWithGstin).toBe(2);
  });

  it('would detect a gap if one ever appeared', () => {
    const fake = [
      { status: 'TICKETED', gst: { gstin: '29AABCC1234D1Z5' }, offer: { landedCost: {}, savingVsRetail: 0 } },
      { status: 'TICKETED', gst: { gstin: '' }, offer: { landedCost: {}, savingVsRetail: 0 } },
    ] as unknown as Booking[];
    expect(attachRates(fake).gstinAttachRate).toBe(0.5);
  });
});

describe('FR-RPT-3 — realised savings', () => {
  beforeEach(resetWorld);

  it('sums the corporate delta and the recoverable ITC', async () => {
    const { booking } = await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    const s = savingsSummary(store.listBookings());

    expect(s.realisedCorporateSaving).toBe(booking.offer.savingVsRetail);
    expect(s.itcRecoverable).toBe(booking.offer.landedCost.recoverableItc);
    expect(s.totalSaving).toBe(s.realisedCorporateSaving + s.itcRecoverable);
  });

  it('computes the saving from the stored comparator, not a percentage', async () => {
    const { booking } = await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    // The comparator was captured at search time against the same flight.
    expect(booking.offer.retailComparatorId).toBeDefined();
    expect(savingsSummary(store.listBookings()).realisedCorporateSaving).toBe(booking.offer.savingVsRetail);
  });

  it('credits no fare discount to a retail booking, but still counts its ITC', async () => {
    await bookOne({ fareType: 'RETAIL', reason: 'timing', key: 'k2' });
    const s = savingsSummary(store.listBookings());
    expect(s.realisedCorporateSaving).toBe(0);
    expect(s.itcRecoverable).toBeGreaterThan(0);
  });

  it('reconciles: net cost + ITC === total payable', async () => {
    await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    const s = savingsSummary(store.listBookings());
    expect(s.netCost + s.itcRecoverable).toBe(s.totalPayable);
  });

  it('keeps the saving rate in a believable range', async () => {
    await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    const s = savingsSummary(store.listBookings());
    // 5-10% corporate discount + ~4.8% ITC. Anything near the 30% marketing
    // ceilings research.md §4.1 warns about would signal a modelling error.
    expect(s.savingRatePct!).toBeGreaterThan(5);
    expect(s.savingRatePct!).toBeLessThan(20);
  });
});

describe('FR-SVC-3 — credit shells', () => {
  beforeEach(resetWorld);

  it('issues a credit shell on cancellation', async () => {
    const { booking, session, provider } = await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    const cancelled = await new ServicingService(provider).cancel(booking.id, session.id);

    expect(cancelled.creditShell).toBeDefined();
    expect(cancelled.creditShell?.amount).toBe(cancelled.refundAmount);
    expect(cancelled.creditShell?.carrier).toBe(booking.offer.carrier);
    expect(cancelled.creditShell?.consumed).toBe(false);
  });

  it('sets a one year validity so the value does not silently expire', async () => {
    const { booking, session, provider } = await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    const cancelled = await new ServicingService(provider).cancel(booking.id, session.id);
    const issued = new Date(cancelled.creditShell!.issuedAt).getTime();
    const expires = new Date(cancelled.creditShell!.expiresAt).getTime();
    expect(Math.round((expires - issued) / 86_400_000)).toBe(365);
  });

  it('aggregates unused value by carrier', async () => {
    const { booking, session, provider } = await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    await new ServicingService(provider).cancel(booking.id, session.id);

    const c = creditShells(store.listBookings());
    expect(c.count).toBe(1);
    expect(c.totalHeld).toBeGreaterThan(0);
    expect(c.byCarrier[0]!.carrier).toBe(booking.offer.carrier);
  });

  it('reports nothing held when no bookings are cancelled', async () => {
    await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    expect(creditShells(store.listBookings()).count).toBe(0);
  });
});

describe('FR-GST-4 — both invoices are captured', () => {
  beforeEach(resetWorld);

  it('records an airline fare invoice and an agent service fee invoice', async () => {
    const { booking } = await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    expect(booking.invoices).toHaveLength(2);

    const airline = booking.invoices.find((i) => i.kind === 'AIRLINE_FARE')!;
    const agent = booking.invoices.find((i) => i.kind === 'AGENT_SERVICE_FEE')!;

    // The big number flows from the AIRLINE's GSTIN, not ours (research.md §5.4).
    expect(airline.supplierGstin).not.toBe(agent.supplierGstin);
    expect(airline.recipientGstin).toBe(booking.gst.gstin);
    expect(agent.recipientGstin).toBe(booking.gst.gstin);
    expect(airline.gstAmount).toBe(booking.offer.price.gstAmount);
  });

  it('charges 18% on the agent service fee', () => {
    const org = store.getOrganisation();
    const invoices = buildInvoices(
      {
        carrier: '6E',
        price: { baseFare: rupees(5000), taxesAndFees: 0, gstRate: 0.05, gstAmount: rupees(250), total: rupees(5250) },
      } as never,
      { gstin: '29AABCC1234D1Z5' } as never,
      org,
      'CFB-ABC123',
    );
    const agent = invoices.find((i) => i.kind === 'AGENT_SERVICE_FEE')!;
    expect(agent.gstRate).toBe(0.18);
    expect(agent.gstAmount).toBe(Math.round(org.serviceFeePerBooking * 0.18));
  });

  it('totals recoverable ITC across both invoices', async () => {
    const { booking } = await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    const total = totalRecoverableItc(booking.invoices);
    expect(total).toBeGreaterThan(booking.offer.landedCost.recoverableItc);
  });
});

describe('dashboard headlines — the numbers are read for the user', () => {
  beforeEach(resetWorld);

  it('flags forgone savings when a corporate fare was declined', async () => {
    await bookOne({ fareType: 'RETAIL', reason: 'timing', key: 'k2' });
    const d = dashboard(store.listBookings(), store.listLegTelemetry());
    expect(d.headlines.join(' ')).toMatch(/declined an available corporate fare/);
  });

  it('reports a clean bill when there is no leakage', async () => {
    await bookOne({ fareType: 'CORPORATE', key: 'k1' });
    const d = dashboard(store.listBookings(), store.listLegTelemetry());
    expect(d.headlines.join(' ')).toMatch(/No leakage detected/);
  });

  it('warns that a broken corporate leg makes the attach rate look better than reality', async () => {
    const { mockControl } = await import('../src/supply/mock/control.js');
    mockControl.failLeg({ carrier: '6E', fareScope: 'CORPORATE', failure: 'AUTH_FAILURE' });
    const { orchestrator } = newOrchestrator();
    makeSession();
    await orchestrator.search(criteria());

    const d = dashboard(store.listBookings(), store.listLegTelemetry());
    expect(d.headlines.join(' ')).toMatch(/Corporate fare queries are failing/);
  });

  it('computes leg success rates, treating NO_INVENTORY as a healthy outcome', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    await orchestrator.search(criteria());
    const rows = legHealth(store.listLegTelemetry());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.successRate).toBe(1);
  });
});
