import { beforeEach, describe, expect, it } from 'vitest';
import { complianceReport, gstr2bCsv, gstr2bLines, spendReport } from '../src/reporting/finance.js';
import { BookingService } from '../src/booking/bookingService.js';
import { ServicingService } from '../src/booking/servicing.js';
import { createHold } from '../src/booking/hold.js';
import { issueMockToken } from '../src/booking/payment.js';
import { store } from '../src/store/store.js';
import {
  ALLOCATION,
  criteria,
  entityFor,
  makeSession,
  newOrchestrator,
  PASSENGER,
  resetWorld,
} from './helpers.js';

/**
 * Stage 4 finance — FR-RPT-4, FR-RPT-5, FR-GST-6.
 *
 * Travel at a consulting firm is mostly rebilled, so allocation is what
 * separates recoverable cost from overhead. And post-Oct-2022 the ITC claim is
 * locked to what appears in GSTR-2B (research.md §5.2), so a booking that
 * cannot be matched to a supplier filing is a credit at risk.
 */
async function book(alloc: typeof ALLOCATION, key: string, fareType: 'CORPORATE' | 'RETAIL' = 'CORPORATE') {
  const { provider, orchestrator } = newOrchestrator();
  const session = makeSession();
  const entity = entityFor(session);
  const result = await orchestrator.search(criteria());
  const offer =
    fareType === 'CORPORATE'
      ? result.offers.find((o) => o.fareType === 'CORPORATE' && o.policy!.compliant)!
      : result.offers.find((o) => o.fareType === 'RETAIL' && o.corporateAlternativeId && o.policy!.compliant)!;
  const hold = createHold(offer, session.id);
  const { booking } = await new BookingService(provider).book({
    holdId: hold.id,
    session,
    entity,
    passengers: [PASSENGER],
    paymentToken: issueMockToken(),
    allocation: alloc,
    ...(fareType === 'RETAIL' ? { retailOverCorporateReason: 'fixture' } : {}),
    idempotencyKey: key,
  });
  return { booking, session, provider };
}

describe('FR-BOOK-1 — allocation is mandatory and validated', () => {
  beforeEach(resetWorld);

  it('records project, cost centre and billability on the booking', async () => {
    const { booking } = await book(ALLOCATION, 'k1');
    expect(booking.allocation.projectCode).toBe('PRJ-4471');
    expect(booking.allocation.costCentreCode).toBe('CC-CONS');
    expect(booking.allocation.clientBillable).toBe(true);
  });

  it('carries the allocation into the audit trail', async () => {
    const { booking } = await book(ALLOCATION, 'k1');
    expect(booking.audit[0]!.detail?.['allocation']).toEqual(ALLOCATION);
  });
});

describe('FR-RPT-4 — spend by project, cost centre and billability', () => {
  beforeEach(resetWorld);

  it('splits spend across projects', async () => {
    await book(ALLOCATION, 'k1');
    await book({ projectCode: 'PRJ-5010', costCentreCode: 'CC-CONS', clientBillable: true }, 'k2');

    const r = spendReport(store.listBookings(), store.getOrganisation());
    expect(r.byProject).toHaveLength(2);
    expect(r.byProject.map((p) => p.key).sort()).toEqual(['PRJ-4471', 'PRJ-5010']);
  });

  it('labels rows with the human project name, not just the code', async () => {
    await book(ALLOCATION, 'k1');
    const r = spendReport(store.listBookings(), store.getOrganisation());
    expect(r.byProject[0]!.label).toBe('Retail Banking Cost Programme');
  });

  it('separates client-billable from internal spend', async () => {
    await book(ALLOCATION, 'k1');
    await book({ projectCode: 'PRJ-0001', costCentreCode: 'CC-INT', clientBillable: false }, 'k2');

    const r = spendReport(store.listBookings(), store.getOrganisation());
    const billable = r.clientBillable.find((x) => x.key === 'billable')!;
    const internal = r.clientBillable.find((x) => x.key === 'internal')!;
    expect(billable.bookings).toBe(1);
    expect(internal.bookings).toBe(1);
  });

  it('tracks corporate fare uptake per project', async () => {
    await book(ALLOCATION, 'k1', 'CORPORATE');
    await book(ALLOCATION, 'k2', 'RETAIL');
    const r = spendReport(store.listBookings(), store.getOrganisation());
    const row = r.byProject.find((p) => p.key === 'PRJ-4471')!;
    expect(row.bookings).toBe(2);
    expect(row.corporateFareBookings).toBe(1);
  });

  it('reconciles net + ITC to total in every row', async () => {
    await book(ALLOCATION, 'k1');
    const r = spendReport(store.listBookings(), store.getOrganisation());
    for (const row of [...r.byProject, ...r.byCostCentre, ...r.clientBillable]) {
      expect(row.netCost + row.recoverableItc).toBe(row.totalPayable);
    }
  });

  it('excludes cancelled bookings from spend', async () => {
    const { booking, session, provider } = await book(ALLOCATION, 'k1');
    await new ServicingService(provider).cancel(booking.id, session.id);
    expect(spendReport(store.listBookings(), store.getOrganisation()).byProject).toHaveLength(0);
  });
});

describe('FR-RPT-5 — policy compliance', () => {
  beforeEach(resetWorld);

  it('is 100% when every booking is in policy', async () => {
    await book(ALLOCATION, 'k1');
    const c = complianceReport(store.listBookings());
    expect(c.complianceRate).toBe(1);
    expect(c.outOfPolicy).toBe(0);
  });

  it('counts breaches by rule and lists the justifications', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(
      criteria({ departDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }),
    );
    const offer = result.offers.find((o) => o.fareType === 'CORPORATE' && !o.policy!.compliant)!;
    const hold = createHold(offer, session.id);
    await new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      policyJustification: 'Client escalation',
      idempotencyKey: 'k_soft',
    });

    const c = complianceReport(store.listBookings());
    expect(c.outOfPolicy).toBe(1);
    expect(c.complianceRate).toBe(0);
    expect(c.breachesByRule.some((b) => b.rule === 'ADVANCE_PURCHASE')).toBe(true);
    expect(c.justifications[0]!.reason).toBe('Client escalation');
    expect(c.justifications[0]!.breaches.length).toBeGreaterThan(0);
  });

  it('is null with nothing to measure', () => {
    expect(complianceReport([]).complianceRate).toBeNull();
  });
});

describe('FR-GST-6 — GSTR-2B reconciliation ledger', () => {
  beforeEach(resetWorld);

  it('emits one line per invoice, not per booking', async () => {
    await book(ALLOCATION, 'k1');
    const lines = gstr2bLines(store.listBookings());
    // Airline fare invoice + agent service fee invoice.
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.invoiceKind).sort()).toEqual(['AGENT_SERVICE_FEE', 'AIRLINE_FARE']);
  });

  it('carries supplier and recipient GSTINs so lines can be matched', async () => {
    const { booking } = await book(ALLOCATION, 'k1');
    for (const l of gstr2bLines(store.listBookings())) {
      expect(l.recipientGstin).toBe(booking.gst.gstin);
      expect(l.supplierGstin).toMatch(/^[0-9]{2}[A-Z]{5}/);
    }
  });

  it('carries the allocation so finance can rebill from the ledger', async () => {
    await book(ALLOCATION, 'k1');
    for (const l of gstr2bLines(store.listBookings())) {
      expect(l.projectCode).toBe('PRJ-4471');
      expect(l.costCentreCode).toBe('CC-CONS');
    }
  });

  it('flags reversed ITC on a cancelled booking', async () => {
    const { booking, session, provider } = await book(ALLOCATION, 'k1');
    await new ServicingService(provider).cancel(booking.id, session.id);

    const lines = gstr2bLines(store.listBookings());
    expect(lines.every((l) => l.itcReversed)).toBe(true);
    expect(lines.every((l) => l.status === 'CANCELLED')).toBe(true);
  });

  it('exports CSV with a header and one row per line', async () => {
    await book(ALLOCATION, 'k1');
    const csv = gstr2bCsv(gstr2bLines(store.listBookings()));
    const rows = csv.trim().split('\n');
    expect(rows[0]).toContain('booking_reference');
    expect(rows[0]).toContain('supplier_gstin');
    expect(rows).toHaveLength(3); // header + 2 invoices
  });

  it('writes rupees with two decimals, not paise', async () => {
    await book(ALLOCATION, 'k1');
    const csv = gstr2bCsv(gstr2bLines(store.listBookings()));
    const dataRow = csv.trim().split('\n')[1]!.split(',');
    // taxable_value_inr is column 7 (index 6)
    expect(dataRow[6]).toMatch(/^\d+\.\d{2}$/);
  });

  it('produces an empty ledger with no bookings', () => {
    expect(gstr2bLines([])).toHaveLength(0);
    expect(gstr2bCsv([]).split('\n')).toHaveLength(1);
  });
});
