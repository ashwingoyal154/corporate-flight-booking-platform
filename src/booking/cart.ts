import type { FareOffer } from '../domain/types.js';
import { MixedFareTypeError } from '../domain/errors.js';

/**
 * Cart boundary — CON-1, FR-SRCH-3.
 *
 * IndiGo corporate and retail fares are retrieved with separate Agency
 * IDs/PCCs and cannot be combined; attempting it fails at the provider with
 * warning 701422 (research.md §1). Rather than discover that at ticketing, we
 * reject it here, before any provider call is made.
 *
 * The rule is enforced at the CART boundary, not in the UI, so no client and no
 * future API caller can route around it.
 */
export function assertNoMixedFareTypes(offers: FareOffer[]): void {
  const seen = new Map<string, Set<string>>();
  for (const offer of offers) {
    const types = seen.get(offer.carrier) ?? new Set<string>();
    types.add(offer.fareType);
    seen.set(offer.carrier, types);
  }
  for (const [carrier, types] of seen) {
    if (types.size > 1) throw new MixedFareTypeError(carrier);
  }
}

export interface CartTotals {
  totalPayable: number;
  recoverableItc: number;
  netCost: number;
  corporateOfferCount: number;
  retailOfferCount: number;
}

export function cartTotals(offers: FareOffer[]): CartTotals {
  return {
    totalPayable: offers.reduce((s, o) => s + o.landedCost.totalPayable, 0),
    recoverableItc: offers.reduce((s, o) => s + o.landedCost.recoverableItc, 0),
    netCost: offers.reduce((s, o) => s + o.landedCost.netCost, 0),
    corporateOfferCount: offers.filter((o) => o.fareType === 'CORPORATE').length,
    retailOfferCount: offers.filter((o) => o.fareType === 'RETAIL').length,
  };
}
