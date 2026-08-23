import { beforeEach, describe, expect, it } from 'vitest';
import { declinesCorporateFare, explainRanking, rankOffers, scoreOffer } from '../src/search/ranking.js';
import { BookingService } from '../src/booking/bookingService.js';
import { createHold } from '../src/booking/hold.js';
import { issueMockToken } from '../src/booking/payment.js';
import { JustificationRequiredError } from '../src/domain/errors.js';
import { rupees } from '../src/domain/money.js';
import { store } from '../src/store/store.js';
import { criteria, entityFor, makeSession, newOrchestrator, PASSENGER, resetWorld, ALLOCATION, pickBookable} from './helpers.js';
import type { FareOffer } from '../src/domain/types.js';

/**
 * Stage 3 — FR-DISP-3 / FR-DISP-4.
 *
 * These are the product's nudges, and plan.md is explicit that they are
 * UNVALIDATED hypotheses: the nudge-benchmark research never ran. The tests
 * therefore pin the mechanics and the honesty properties (nothing is reordered
 * silently, nothing is forgone invisibly) rather than claiming an uplift.
 */
function offer(over: Partial<FareOffer> = {}): FareOffer {
  return {
    id: 'o1',
    carrier: '6E',
    fareType: 'RETAIL',
    fareBrand: 'test',
    segments: [
      {
        carrier: '6E',
        flightNumber: '6E-1',
        origin: 'DEL',
        destination: 'BOM',
        departsAt: '2026-09-01T06:00:00.000Z',
        arrivesAt: '2026-09-01T08:00:00.000Z',
        durationMinutes: 120,
      },
    ],
    price: { baseFare: rupees(5000), taxesAndFees: 0, gstRate: 0.05, gstAmount: rupees(250), total: rupees(5250) },
    landedCost: {
      totalPayable: rupees(5250),
      recoverableItc: rupees(250),
      netCost: rupees(5000),
      changeFee: rupees(3000),
      cancelFee: rupees(3000),
    },
    inclusions: [],
    cabin: 'ECONOMY',
    ...over,
  };
}

describe('FR-DISP-3 — ranking by landed cost, not headline price', () => {
  beforeEach(resetWorld);

  it('scores on net cost plus weighted change exposure', () => {
    const o = offer();
    // net 5000 + (3000 change x 0.25) = 5750
    expect(scoreOffer(o, { changeProbability: 0.25 })).toBe(rupees(5750));
  });

  it('ranks a dearer headline fare first when its landed cost is lower', () => {
    // Cheaper headline, but no ITC and an expensive change.
    const cheapHeadline = offer({
      id: 'cheap',
      landedCost: {
        totalPayable: rupees(5200),
        recoverableItc: 0,
        netCost: rupees(5200),
        changeFee: rupees(3000),
        cancelFee: rupees(3000),
      },
    });
    // Dearer headline, but recoverable ITC and a cheap change.
    const betterLanded = offer({
      id: 'better',
      fareType: 'CORPORATE',
      landedCost: {
        totalPayable: rupees(5300),
        recoverableItc: rupees(250),
        netCost: rupees(5050),
        changeFee: rupees(499),
        cancelFee: rupees(1199),
      },
    });

    const ranked = rankOffers([cheapHeadline, betterLanded], { changeProbability: 0.25 });

    expect(ranked[0]!.id).toBe('better');
    // …and it is genuinely the dearer sticker price, which is the whole point.
    expect(ranked[0]!.landedCost.totalPayable).toBeGreaterThan(cheapHeadline.landedCost.totalPayable);
  });

  it('never reorders silently — every offer carries its reasons', () => {
    const ranked = rankOffers([offer()], { changeProbability: 0.25 });
    expect(ranked[0]!.rankingReasons?.length).toBeGreaterThan(0);
    expect(ranked[0]!.rankingScore).toBeGreaterThan(0);
  });

  it('explains ITC, the corporate delta and change exposure', () => {
    const reasons = explainRanking(
      offer({ fareType: 'CORPORATE', savingVsRetail: rupees(400) }),
      { changeProbability: 0.25 },
    );
    const text = reasons.join(' | ');
    expect(text).toContain('input tax credit');
    expect(text).toContain('below the retail fare');
    expect(text).toContain('Change fee');
  });

  it('calls out a zero change fee rather than burying it', () => {
    const reasons = explainRanking(
      offer({ landedCost: { ...offer().landedCost, changeFee: 0 } }),
      { changeProbability: 0.25 },
    );
    expect(reasons).toContain('No change fee');
  });

  it('reads the change weighting from configuration, not a constant', () => {
    const o = offer();
    expect(scoreOffer(o, { changeProbability: 0 })).toBe(rupees(5000));
    expect(scoreOffer(o, { changeProbability: 1 })).toBe(rupees(8000));
  });

  it('breaks ties predictably by departure time', () => {
    const a = offer({ id: 'later', segments: [{ ...offer().segments[0]!, departsAt: '2026-09-01T18:00:00.000Z' }] });
    const b = offer({ id: 'earlier', segments: [{ ...offer().segments[0]!, departsAt: '2026-09-01T06:00:00.000Z' }] });
    const ranked = rankOffers([a, b], { changeProbability: 0.25 });
    expect(ranked[0]!.id).toBe('earlier');
  });

  it('returns real search results already ranked', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());
    const scores = result.offers.map((o) => o.rankingScore!);
    expect(scores).toEqual([...scores].sort((x, y) => x - y));
  });
});

describe('FR-DISP-4 — declining an available corporate fare is a recorded decision', () => {
  beforeEach(resetWorld);

  it('marks retail offers that have a corporate alternative on the same flight', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());

    const retailWithAlt = result.offers.filter((o) => o.fareType === 'RETAIL' && o.corporateAlternativeId);
    expect(retailWithAlt.length).toBeGreaterThan(0);

    for (const r of retailWithAlt) {
      const corp = result.offers.find((o) => o.id === r.corporateAlternativeId)!;
      expect(corp.fareType).toBe('CORPORATE');
      expect(corp.segments[0]!.flightNumber).toBe(r.segments[0]!.flightNumber);
      expect(r.corporateAlternativeSaving).toBe(corp.savingVsRetail);
    }
  });

  it('detects the decline case', () => {
    expect(declinesCorporateFare(offer({ corporateAlternativeId: 'x' }))).toBe(true);
    expect(declinesCorporateFare(offer())).toBe(false);
    // A corporate fare never "declines" itself.
    expect(declinesCorporateFare(offer({ fareType: 'CORPORATE', corporateAlternativeId: 'x' }))).toBe(false);
  });

  it('blocks the booking when no reason is given', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const retail = pickBookable(result, { fareType: 'RETAIL', needsCorporateAlternative: true });
    const hold = createHold(retail, session.id);

    await expect(
      new BookingService(provider).book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_nojust',
      }),
    ).rejects.toThrow(JustificationRequiredError);
  });

  it('reports the forgone saving so the cost of the choice is visible', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const retail = pickBookable(result, { fareType: 'RETAIL', needsCorporateAlternative: true });
    const hold = createHold(retail, session.id);

    try {
      await new BookingService(provider).book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_nojust2',
      });
      expect.unreachable();
    } catch (err) {
      const e = err as JustificationRequiredError;
      expect(e.constraintRef).toBe('FR-DISP-4');
      expect(e.detail?.['forgoneSaving']).toBe(retail.corporateAlternativeSaving);
    }
  });

  it('books with a reason, and records it against the booking', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const retail = pickBookable(result, { fareType: 'RETAIL', needsCorporateAlternative: true });
    const hold = createHold(retail, session.id);

    const { booking } = await new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      retailOverCorporateReason: 'Corporate fare timing did not fit the client meeting',
      idempotencyKey: 'idem_just_ok',
    });

    expect(booking.retailOverCorporate?.reason).toContain('client meeting');
    expect(booking.retailOverCorporate?.forgoneSaving).toBe(retail.corporateAlternativeSaving);
    expect(booking.retailOverCorporate?.corporateOfferId).toBe(retail.corporateAlternativeId);
  });

  it('does NOT demand a reason when no corporate fare was available', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);

    // Remove every corporate config so no alternative exists.
    const org = store.getOrganisation();
    org.corporateFareConfigs = [];
    store.setOrganisation(org);

    const { orchestrator: o2 } = newOrchestrator(provider);
    const result = await o2.search(criteria());
    const retail = pickBookable(result, { fareType: 'RETAIL' });
    expect(retail.corporateAlternativeId).toBeUndefined();

    const hold = createHold(retail, session.id);
    const { booking } = await new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'idem_nocorp',
    });
    expect(booking.status).toBe('TICKETED');
    expect(booking.retailOverCorporate).toBeUndefined();
  });

  it('rejects a whitespace-only reason', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const retail = pickBookable(result, { fareType: 'RETAIL', needsCorporateAlternative: true });
    const hold = createHold(retail, session.id);

    await expect(
      new BookingService(provider).book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        retailOverCorporateReason: '    ',
        idempotencyKey: 'idem_blank',
      }),
    ).rejects.toThrow(JustificationRequiredError);
  });
});
