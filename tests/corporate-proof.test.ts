import { beforeEach, describe, expect, it } from 'vitest';
import { BookingService } from '../src/booking/bookingService.js';
import { createHold } from '../src/booking/hold.js';
import { issueMockToken } from '../src/booking/payment.js';
import { store } from '../src/store/store.js';
import { criteria, entityFor, makeSession, newOrchestrator, PASSENGER, resetWorld, ALLOCATION, pickBookable} from './helpers.js';

/**
 * FR-SRCH-5 / FR-BOOK-6 / FR-DISP-1 — the corporate fare evidence chain.
 *
 * Without a durable proof marker there is no way to tell whether a corporate
 * fare was actually applied, which makes attach-rate reporting (FR-RPT-1) and
 * every traveller-facing nudge unfalsifiable.
 */
describe('FR-SRCH-5 — corporate offers carry proof markers', () => {
  beforeEach(resetWorld);

  it('marks corporate offers as private fares and records the mechanism', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());

    const corporate = result.offers.filter((o) => o.fareType === 'CORPORATE');
    expect(corporate.length).toBeGreaterThan(0);
    for (const o of corporate) {
      expect(o.corporateProof).toBeDefined();
      expect(o.corporateProof?.privateFare).toBe(true);
      expect(o.corporateProof?.mechanism).toBeTruthy();
      expect(o.corporateProof?.credentialRef).toMatch(/^secret:\/\//);
    }
  });

  it('records the mechanism configured per carrier (CON-7)', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());

    const byCarrier = (c: string) =>
      result.offers.find((o) => o.carrier === c && o.fareType === 'CORPORATE')?.corporateProof?.mechanism;

    // Mirrors research.md §3: IndiGo is credential-gated, FSCs use account codes,
    // Akasa uses a promo code, SpiceJet a negotiated contract.
    expect(byCarrier('6E')).toBe('CREDENTIAL');
    expect(byCarrier('AI')).toBe('ACCOUNT_CODE');
    expect(byCarrier('QP')).toBe('PROMO_CODE');
    expect(byCarrier('SG')).toBe('CONTRACT_CODE');
  });

  it('never marks a retail offer as corporate', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());
    for (const o of result.offers.filter((x) => x.fareType === 'RETAIL')) {
      expect(o.corporateProof).toBeUndefined();
    }
  });

  it('never leaks the credential itself, only its reference (FR-ORG-3, NFR-6)', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());
    const serialised = JSON.stringify(result);
    expect(serialised).toContain('secret://');
    // A `secret://` URI is a pointer; no resolved secret value should appear.
    expect(serialised).not.toMatch(/password|apikey|api_key|bearer /i);
  });
});

describe('FR-DISP-1 — the saving is a real like-for-like delta', () => {
  beforeEach(resetWorld);

  it('pairs each corporate offer with the retail offer on the SAME flight', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());

    const corporate = result.offers.filter((o) => o.fareType === 'CORPORATE');
    for (const c of corporate) {
      expect(c.retailComparatorId).toBeDefined();
      const retail = result.offers.find((o) => o.id === c.retailComparatorId)!;
      expect(retail.fareType).toBe('RETAIL');
      expect(retail.carrier).toBe(c.carrier);
      expect(retail.segments[0]!.flightNumber).toBe(c.segments[0]!.flightNumber);
    }
  });

  it('computes the saving from the comparator, not a marketing percentage', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());

    for (const c of result.offers.filter((o) => o.fareType === 'CORPORATE')) {
      const retail = result.offers.find((o) => o.id === c.retailComparatorId)!;
      expect(c.savingVsRetail).toBe(retail.price.total - c.price.total);
      expect(c.savingVsRetail!).toBeGreaterThan(0);
    }
  });

  it('keeps the discount inside the credible 5-10% researched band', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());

    for (const c of result.offers.filter((o) => o.fareType === 'CORPORATE')) {
      const retail = result.offers.find((o) => o.id === c.retailComparatorId)!;
      const pct = (retail.price.baseFare - c.price.baseFare) / retail.price.baseFare;
      // research.md §6.2: ITILITE's 5-10% is the only credible published band.
      // Marketing ceilings of 30% are deliberately not modelled.
      expect(pct).toBeGreaterThanOrEqual(0.049);
      expect(pct).toBeLessThanOrEqual(0.101);
    }
  });
});

describe('FR-BOOK-6 — proof is persisted onto the booking', () => {
  beforeEach(resetWorld);

  it('stores fare type, credential ref and proof markers', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const offer = result.offers.find((o) => o.carrier === '6E' && o.fareType === 'CORPORATE')!;
    const hold = createHold(offer, session.id);

    const { booking } = await new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'idem_proof',
    });

    expect(booking.corporateFareApplied).toBe(true);
    expect(booking.offer.corporateProof?.privateFare).toBe(true);
    expect(booking.credentialRef).toBe('secret://supply/indigo/corporate-agency-id');
    expect(booking.supplyProvider).toBe('mock');
    // Enough to compute attach rate (FR-RPT-1) and realised savings (FR-RPT-3).
    expect(booking.offer.savingVsRetail).toBeGreaterThan(0);
  });

  it('records a retail booking as not corporate', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const offer = pickBookable(result, { fareType: 'RETAIL', needsCorporateAlternative: true });
    const hold = createHold(offer, session.id);

    const { booking } = await new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      // Stage 3 (FR-DISP-4): declining an available corporate fare needs a reason.
      retailOverCorporateReason: 'proof fixture',
      idempotencyKey: 'idem_proof_retail',
    });

    expect(booking.corporateFareApplied).toBe(false);
    expect(booking.offer.corporateProof).toBeUndefined();
    expect(booking.credentialRef).toContain('/retail');
  });
});
