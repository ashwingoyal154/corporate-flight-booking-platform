import { beforeEach, describe, expect, it } from 'vitest';
import { annotateOffers, defaultPolicy, evaluateOffer, summarise } from '../src/policy/engine.js';
import { BookingService } from '../src/booking/bookingService.js';
import { createHold } from '../src/booking/hold.js';
import { issueMockToken } from '../src/booking/payment.js';
import { PolicyBlockedError, PolicyJustificationRequiredError } from '../src/domain/errors.js';
import { rupees } from '../src/domain/money.js';
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
import type { FareOffer, TravelPolicy } from '../src/domain/types.js';

/**
 * Stage 4 — FR-POL-2, FR-POL-3.
 *
 * v1 evaluates against a SINGLE default policy. Grade-based rules (FR-POL-1)
 * and per-client overrides (FR-POL-6) need identity and land in Stage 6.
 */
function offer(over: Partial<FareOffer> = {}): FareOffer {
  return {
    id: 'o1',
    carrier: '6E',
    fareType: 'CORPORATE',
    fareBrand: 'test',
    segments: [
      {
        carrier: '6E',
        flightNumber: '6E-1',
        origin: 'DEL',
        destination: 'BOM',
        departsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        arrivesAt: new Date(Date.now() + 30 * 86_400_000 + 7_200_000).toISOString(),
        durationMinutes: 120,
      },
    ],
    price: { baseFare: rupees(5000), taxesAndFees: 0, gstRate: 0.05, gstAmount: rupees(250), total: rupees(5250) },
    landedCost: {
      totalPayable: rupees(5250),
      recoverableItc: rupees(250),
      netCost: rupees(5000),
      changeFee: rupees(499),
      cancelFee: rupees(1199),
    },
    inclusions: [],
    cabin: 'ECONOMY',
    ...over,
  };
}

const policy = (rules: TravelPolicy['rules']): TravelPolicy => ({
  id: 'pol_test',
  name: 'test',
  isDefault: true,
  rules,
});

describe('FR-POL-2 — offers are labelled in or out of policy', () => {
  beforeEach(resetWorld);

  it('passes a compliant offer', () => {
    const e = evaluateOffer(offer(), policy([{ kind: 'MAX_FARE', enforcement: 'SOFT', amount: rupees(10000) }]));
    expect(e.compliant).toBe(true);
    expect(e.breaches).toHaveLength(0);
    expect(e.requiresJustification).toBe(false);
    expect(e.blocked).toBe(false);
  });

  it('compares the fare cap against LANDED cost, not the headline price', () => {
    // Headline 5,250 exceeds a 5,100 cap; net cost after ITC is 5,000 and does not.
    const e = evaluateOffer(offer(), policy([{ kind: 'MAX_FARE', enforcement: 'SOFT', amount: rupees(5100) }]));
    expect(e.compliant).toBe(true);
  });

  it('breaches the cap when even the net cost exceeds it', () => {
    const e = evaluateOffer(offer(), policy([{ kind: 'MAX_FARE', enforcement: 'SOFT', amount: rupees(4000) }]));
    expect(e.compliant).toBe(false);
    expect(e.breaches[0]!.rule).toBe('MAX_FARE');
    expect(e.breaches[0]!.message).toContain('exceeds');
  });

  it('applies a cabin-scoped cap only to that cabin', () => {
    const rules = policy([{ kind: 'MAX_FARE', enforcement: 'SOFT', amount: rupees(100), cabin: 'PREMIUM' }]);
    expect(evaluateOffer(offer({ cabin: 'ECONOMY' }), rules).compliant).toBe(true);
    expect(evaluateOffer(offer({ cabin: 'PREMIUM' }), rules).compliant).toBe(false);
  });

  it('enforces the advance-purchase window', () => {
    const soon = offer({
      segments: [{ ...offer().segments[0]!, departsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }],
    });
    const e = evaluateOffer(soon, policy([{ kind: 'ADVANCE_PURCHASE', enforcement: 'SOFT', minDays: 7 }]));
    expect(e.compliant).toBe(false);
    expect(e.breaches[0]!.message).toContain('before departure');
  });

  it('flags a non-preferred carrier', () => {
    const e = evaluateOffer(
      offer({ carrier: 'SG' }),
      policy([{ kind: 'PREFERRED_CARRIER', enforcement: 'SOFT', carriers: ['6E', 'AI'] }]),
    );
    expect(e.compliant).toBe(false);
    expect(e.breaches[0]!.message).toContain('SpiceJet');
  });

  it('reports every breach, not just the first', () => {
    const e = evaluateOffer(
      offer({ carrier: 'SG' }),
      policy([
        { kind: 'MAX_FARE', enforcement: 'SOFT', amount: rupees(100) },
        { kind: 'PREFERRED_CARRIER', enforcement: 'SOFT', carriers: ['6E'] },
      ]),
    );
    expect(e.breaches).toHaveLength(2);
  });

  it('sorts hard breaches ahead of soft ones', () => {
    const e = evaluateOffer(
      offer({ cabin: 'PREMIUM', carrier: 'SG' }),
      policy([
        { kind: 'PREFERRED_CARRIER', enforcement: 'SOFT', carriers: ['6E'] },
        { kind: 'CABIN', enforcement: 'HARD', allowed: ['ECONOMY'] },
      ]),
    );
    expect(e.breaches[0]!.enforcement).toBe('HARD');
  });

  it('annotates offers at search time', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());
    for (const o of result.offers) {
      expect(o.policy).toBeDefined();
      expect(o.policy!.policyId).toBe('pol_default');
    }
  });

  it('summarises the verdict in plain language', () => {
    expect(summarise(evaluateOffer(offer(), policy([])))).toBe('In policy');
    expect(
      summarise(evaluateOffer(offer({ cabin: 'PREMIUM' }), policy([{ kind: 'CABIN', enforcement: 'HARD', allowed: ['ECONOMY'] }]))),
    ).toBe('Blocked by policy');
  });

  it('picks the default policy, falling back to the first', () => {
    expect(defaultPolicy([])).toBeUndefined();
    const a = policy([]);
    const b = { ...policy([]), id: 'other', isDefault: false };
    expect(defaultPolicy([b as never, a])!.id).toBe('pol_test');
  });

  it('leaves offers untouched when no policy is configured', () => {
    const offers = [offer()];
    annotateOffers(offers, undefined);
    expect(offers[0]!.policy).toBeUndefined();
  });
});

describe('FR-POL-3 — soft breaches need a reason, hard breaches are blocked', () => {
  beforeEach(resetWorld);

  async function bookPremium(extra: Record<string, unknown> = {}) {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria({ cabin: 'PREMIUM' }));
    const offer = result.offers.find((o) => o.fareType === 'CORPORATE')!;
    const hold = createHold(offer, session.id);
    return new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: `idem_pol_${Math.random()}`,
      ...extra,
    });
  }

  it('blocks a hard breach outright — premium cabin is not permitted', async () => {
    await expect(bookPremium()).rejects.toThrow(PolicyBlockedError);
  });

  it('a hard breach cannot be justified away', async () => {
    await expect(bookPremium({ policyJustification: 'client insisted' })).rejects.toThrow(
      PolicyBlockedError,
    );
  });

  it('requires a justification for a soft breach', async () => {
    // Late booking breaches the 7-day advance-purchase rule softly.
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria({ departDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }));
    const offer = result.offers.find((o) => o.fareType === 'CORPORATE' && !o.policy!.compliant)!;
    const hold = createHold(offer, session.id);

    await expect(
      new BookingService(provider).book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_soft_nojust',
      }),
    ).rejects.toThrow(PolicyJustificationRequiredError);
  });

  it('books a soft breach when justified, and records both verdict and reason', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria({ departDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }));
    const offer = result.offers.find((o) => o.fareType === 'CORPORATE' && !o.policy!.compliant)!;
    const hold = createHold(offer, session.id);

    const { booking } = await new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      policyJustification: 'Client escalation required same-week travel',
      idempotencyKey: 'idem_soft_just',
    });

    expect(booking.status).toBe('TICKETED');
    expect(booking.policyJustification).toContain('Client escalation');
    expect(booking.policyEvaluation!.compliant).toBe(false);
    expect(booking.policyEvaluation!.blocked).toBe(false);
  });

  it('books a compliant fare with no justification at all', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const offer = result.offers.find((o) => o.fareType === 'CORPORATE' && o.policy!.compliant)!;
    const hold = createHold(offer, session.id);

    const { booking } = await new BookingService(provider).book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'idem_compliant',
    });
    expect(booking.policyEvaluation!.compliant).toBe(true);
    expect(booking.policyJustification).toBeUndefined();
  });

  it('makes no provider call when policy blocks the fare', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria({ cabin: 'PREMIUM' }));
    const offer = result.offers[0]!;
    const hold = createHold(offer, session.id);

    let bookCalls = 0;
    const spied = new Proxy(provider, {
      get(t, p, r) {
        if (p === 'book') {
          return async (...a: unknown[]) => {
            bookCalls += 1;
            return (t.book as (...x: unknown[]) => unknown).apply(t, a);
          };
        }
        return Reflect.get(t, p, r);
      },
    });

    await expect(
      new BookingService(spied).book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_blocked_noprovider',
      }),
    ).rejects.toThrow(PolicyBlockedError);
    expect(bookCalls).toBe(0);
  });
});
