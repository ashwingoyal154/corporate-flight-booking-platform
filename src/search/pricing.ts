import type { CabinClass, GstRates, LandedCost, Price } from '../domain/types.js';
import type { ProviderOffer } from '../supply/port.js';
import { computeGst } from '../domain/money.js';

/**
 * Turns a provider offer into a customer-facing price and landed cost.
 *
 * The provider knows fares; we know the customer's tax position. Splitting it
 * this way means a change of supply partner (DEC-1) does not touch GST logic.
 *
 * Simplification: GST is applied to (base fare + carrier taxes and fees). Real
 * filings are more granular; the rate itself is configuration (FR-GST-5, DEC-6).
 */
export function priceOffer(
  offer: ProviderOffer,
  rates: GstRates,
  cabin: CabinClass,
): { price: Price; landedCost: LandedCost } {
  const gstRate = cabin === 'PREMIUM' ? rates.premium : rates.economy;
  const taxableValue = offer.baseFare + offer.taxesAndFees;
  const gstAmount = computeGst(taxableValue, gstRate);
  const total = taxableValue + gstAmount;

  const price: Price = {
    baseFare: offer.baseFare,
    taxesAndFees: offer.taxesAndFees,
    gstRate,
    gstAmount,
    total,
  };

  /**
   * Input tax credit (research.md §5).
   *
   * For a GST-registered business travelling on genuine business, the GST paid
   * is recoverable — so the real cost of the ticket is the total minus that
   * credit. On domestic economy this is ~4.8% of the all-in price, which is the
   * same order as the entire corporate fare discount, and it is why the product
   * displays net cost rather than headline fare (FR-DISP-2).
   *
   * This assumes the GSTIN is correctly attached at booking. It cannot be added
   * afterwards (CON-4) — which is what FR-GST-1 exists to guarantee.
   */
  const landedCost: LandedCost = {
    totalPayable: total,
    recoverableItc: gstAmount,
    netCost: total - gstAmount,
    changeFee: offer.changeFee,
    cancelFee: offer.cancelFee,
  };

  return { price, landedCost };
}
