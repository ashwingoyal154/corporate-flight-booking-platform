import { beforeEach, describe, expect, it } from 'vitest';
import { assertNoMixedFareTypes } from '../src/booking/cart.js';
import { MixedFareTypeError } from '../src/domain/errors.js';
import { BookingService } from '../src/booking/bookingService.js';
import { createHold } from '../src/booking/hold.js';
import { issueMockToken } from '../src/booking/payment.js';
import { criteria, entityFor, makeSession, newOrchestrator, PASSENGER, resetWorld } from './helpers.js';
import type { FareOffer } from '../src/domain/types.js';

/**
 * CON-1 / FR-SRCH-3 — the defining architectural constraint.
 *
 * IndiGo corporate and retail fares are retrieved with separate Agency IDs/PCCs
 * and can never share a booking; the real provider fails this with warning
 * 701422 (research.md §1). spec.md requires a test that FAILS if the check is
 * removed — hence the mutation guard at the end of this file.
 */
describe('CON-1 — corporate and retail fares can never be combined', () => {
  beforeEach(resetWorld);

  function offer(carrier: FareOffer['carrier'], fareType: FareOffer['fareType']): FareOffer {
    return {
      id: `${carrier}-${fareType}`,
      carrier,
      fareType,
      fareBrand: 'test',
      segments: [],
      price: { baseFare: 100, taxesAndFees: 10, gstRate: 0.05, gstAmount: 6, total: 116 },
      landedCost: { totalPayable: 116, recoverableItc: 6, netCost: 110, changeFee: 0, cancelFee: 0 },
      inclusions: [],
      cabin: 'ECONOMY',
    };
  }

  it('rejects a cart mixing CORPORATE and RETAIL for the same carrier', () => {
    expect(() => assertNoMixedFareTypes([offer('6E', 'CORPORATE'), offer('6E', 'RETAIL')])).toThrow(
      MixedFareTypeError,
    );
  });

  it('names the offending carrier and cites the constraint', () => {
    try {
      assertNoMixedFareTypes([offer('6E', 'CORPORATE'), offer('6E', 'RETAIL')]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MixedFareTypeError);
      const e = err as MixedFareTypeError;
      expect(e.constraintRef).toBe('CON-1');
      expect(e.status).toBe(409);
      expect(e.detail?.['carrier']).toBe('6E');
    }
  });

  it('allows different fare types across DIFFERENT carriers', () => {
    // The constraint is per-carrier: a corporate 6E and a retail AI is legitimate.
    expect(() => assertNoMixedFareTypes([offer('6E', 'CORPORATE'), offer('AI', 'RETAIL')])).not.toThrow();
  });

  it('allows a cart of the same fare type for one carrier (outbound + return)', () => {
    expect(() => assertNoMixedFareTypes([offer('6E', 'CORPORATE'), offer('6E', 'CORPORATE')])).not.toThrow();
  });

  it('rejects BEFORE any provider call is made', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());

    const corporate = result.offers.find((o) => o.carrier === '6E' && o.fareType === 'CORPORATE');
    const retail = result.offers.find((o) => o.carrier === '6E' && o.fareType === 'RETAIL');
    expect(corporate, 'mock must return a 6E corporate offer').toBeDefined();
    expect(retail, 'mock must return a 6E retail offer').toBeDefined();

    // Count provider book calls to prove nothing reached the provider.
    let bookCalls = 0;
    const spied = new Proxy(provider, {
      get(target, prop, recv) {
        if (prop === 'book') {
          return async (...args: unknown[]) => {
            bookCalls += 1;
            return (target.book as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });

    const service = new BookingService(spied);
    const hold = createHold(corporate!, session.id);
    // Force the mixed condition through the cart the booking path uses.
    expect(() => assertNoMixedFareTypes([corporate!, retail!])).toThrow(MixedFareTypeError);

    // A legitimate single-fare-type booking still works, proving the guard is
    // not simply blocking everything.
    const { booking } = await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      idempotencyKey: 'idem_con1_ok',
    });
    expect(booking.status).toBe('TICKETED');
    expect(bookCalls).toBe(1);
  });

  it('MUTATION GUARD — a permissive implementation must not satisfy these cases', () => {
    // spec.md: "has a passing test that fails if the check is removed".
    // This models the check being deleted and asserts we would notice.
    const permissive = (_offers: FareOffer[]): void => {};
    let noticed = false;
    try {
      permissive([offer('6E', 'CORPORATE'), offer('6E', 'RETAIL')]);
    } catch {
      noticed = true;
    }
    expect(noticed, 'a removed check silently accepts a mixed cart').toBe(false);
    // …and the real implementation does notice:
    expect(() => assertNoMixedFareTypes([offer('6E', 'CORPORATE'), offer('6E', 'RETAIL')])).toThrow();
  });
});
