import { beforeEach, describe, expect, it } from 'vitest';
import { priceOffer } from '../src/search/pricing.js';
import { formatInr, rupees } from '../src/domain/money.js';
import { store } from '../src/store/store.js';
import { criteria, makeSession, newOrchestrator, resetWorld } from './helpers.js';
import type { ProviderOffer } from '../src/supply/port.js';

/**
 * FR-DISP-2 — landed cost, not headline fare.
 *
 * ITC recovery is ~4.8% of all-in economy cost (research.md §5.3), the same
 * order as the entire corporate fare discount. Displaying headline price alone
 * would systematically mislead the decision.
 */
function offer(base: number, taxes: number): ProviderOffer {
  return {
    providerOfferId: 'test',
    carrier: '6E',
    fareType: 'RETAIL',
    fareBrand: 'test',
    cabin: 'ECONOMY',
    segments: [],
    baseFare: base,
    taxesAndFees: taxes,
    changeFee: 0,
    cancelFee: 0,
    inclusions: [],
  };
}

describe('FR-DISP-2 — landed cost arithmetic', () => {
  beforeEach(resetWorld);

  it('matches the spec acceptance example exactly: ₹6,000 base at 5%', () => {
    // spec.md E3 acceptance: total ₹6,300, recoverable ITC ₹300, net ₹6,000.
    const { price, landedCost } = priceOffer(
      offer(rupees(6000), 0),
      { economy: 0.05, premium: 0.18 },
      'ECONOMY',
    );

    expect(price.total).toBe(rupees(6300));
    expect(landedCost.totalPayable).toBe(rupees(6300));
    expect(landedCost.recoverableItc).toBe(rupees(300));
    expect(landedCost.netCost).toBe(rupees(6000));
    expect(formatInr(landedCost.totalPayable)).toBe('₹6,300');
  });

  it('recovers ~4.76% of the all-in price on domestic economy', () => {
    const { landedCost } = priceOffer(offer(rupees(6000), 0), { economy: 0.05, premium: 0.18 }, 'ECONOMY');
    const pct = landedCost.recoverableItc / landedCost.totalPayable;
    // 5/105 = 4.7619% — the figure the business case rests on.
    expect(pct).toBeCloseTo(0.047619, 5);
  });

  it('applies the premium rate to premium cabins', () => {
    const { price, landedCost } = priceOffer(
      offer(rupees(20000), 0),
      { economy: 0.05, premium: 0.18 },
      'PREMIUM',
    );
    expect(price.gstRate).toBe(0.18);
    expect(landedCost.recoverableItc).toBe(rupees(3600));
    expect(landedCost.totalPayable).toBe(rupees(23600));
  });

  it('reads the GST rate from configuration, never a constant (FR-GST-5, DEC-6)', () => {
    // The 2025 rationalisation is why this must not be hardcoded.
    const a = priceOffer(offer(rupees(6000), 0), { economy: 0.05, premium: 0.18 }, 'ECONOMY');
    const b = priceOffer(offer(rupees(6000), 0), { economy: 0.12, premium: 0.18 }, 'ECONOMY');
    expect(a.price.gstRate).toBe(0.05);
    expect(b.price.gstRate).toBe(0.12);
    expect(b.landedCost.recoverableItc).toBe(rupees(720));
  });

  it('charges GST on base plus carrier taxes', () => {
    const { price } = priceOffer(offer(rupees(6000), rupees(400)), { economy: 0.05, premium: 0.18 }, 'ECONOMY');
    expect(price.gstAmount).toBe(rupees(320));
    expect(price.total).toBe(rupees(6720));
  });

  it('uses integer paise throughout — no floating point drift', () => {
    const { price, landedCost } = priceOffer(offer(333_33, 111_11), { economy: 0.05, premium: 0.18 }, 'ECONOMY');
    for (const v of [price.baseFare, price.gstAmount, price.total, landedCost.netCost]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('always reconciles: netCost + ITC === totalPayable', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());
    expect(result.offers.length).toBeGreaterThan(0);
    for (const o of result.offers) {
      expect(o.landedCost.netCost + o.landedCost.recoverableItc).toBe(o.landedCost.totalPayable);
      expect(o.landedCost.totalPayable).toBe(o.price.total);
    }
  });

  it('formats rupees with Indian digit grouping', () => {
    expect(formatInr(rupees(6300))).toBe('₹6,300');
    expect(formatInr(rupees(123456))).toBe('₹1,23,456');
    expect(formatInr(rupees(10000000))).toBe('₹1,00,00,000');
  });
});

describe('FR-DISP-2 — change and cancel exposure is part of landed cost', () => {
  beforeEach(resetWorld);

  it('carries carrier-specific fees onto every offer (CON-8)', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());

    const akasaCorp = result.offers.find((o) => o.carrier === 'QP' && o.fareType === 'CORPORATE');
    const indigoCorp = result.offers.find((o) => o.carrier === '6E' && o.fareType === 'CORPORATE');
    const indigoRetail = result.offers.find((o) => o.carrier === '6E' && o.fareType === 'RETAIL');

    // Akasa corporate: fee-free changes (research.md §4).
    expect(akasaCorp?.landedCost.changeFee).toBe(0);
    // IndiGo corporate is materially cheaper to change than retail.
    expect(indigoCorp!.landedCost.changeFee).toBeLessThan(indigoRetail!.landedCost.changeFee);
  });
});
