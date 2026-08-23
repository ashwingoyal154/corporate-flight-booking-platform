import type { Booking, CarrierCode } from '../domain/types.js';
import type { LegTelemetry } from '../store/store.js';

/**
 * Reporting — FR-RPT-1 … FR-RPT-6.
 *
 * These metrics are the point of Stage 3: they turn the corporate-fare thesis
 * from an assumption into a measurement. research.md §6.2 found NO credible
 * published figure for the realised discount of an Indian airline corporate
 * fare versus that airline's own retail fare, so the only trustworthy number is
 * the one this system observes.
 *
 * Every figure below is computed from stored booking evidence — the retail
 * comparator captured at search time and the private-fare proof markers — never
 * from a vendor percentage.
 */

export interface AttachRates {
  /** FR-RPT-1 — of bookings where a corporate fare WAS available, how many took it. */
  corporateAttachRate: number | null;
  corporateEligibleBookings: number;
  corporateBookings: number;
  /** Bookings that declined an available corporate fare, with reasons. */
  declinedCorporate: number;
  forgoneSaving: number;
  /** FR-RPT-2 — target is 100%; ITC is uncorrectable after ticketing. */
  gstinAttachRate: number | null;
  bookingsWithGstin: number;
  totalBookings: number;
}

export interface SavingsSummary {
  /** FR-RPT-3 — realised saving vs the retail comparator captured at search. */
  realisedCorporateSaving: number;
  itcRecoverable: number;
  totalSaving: number;
  totalPayable: number;
  netCost: number;
  bookingCount: number;
  averageSavingPerBooking: number;
  /** Saving as a share of what would have been paid at retail without ITC. */
  savingRatePct: number | null;
}

export interface CreditShellSummary {
  totalHeld: number;
  count: number;
  expiringWithin90Days: number;
  byCarrier: Array<{ carrier: CarrierCode; amount: number; count: number }>;
}

export interface LegHealthRow {
  carrier: CarrierCode;
  fareType: string;
  total: number;
  successRate: number;
  outcomes: Record<string, number>;
}

const isLive = (b: Booking): boolean => b.status === 'TICKETED';

/** FR-RPT-1 / FR-RPT-2 */
export function attachRates(bookings: Booking[]): AttachRates {
  const live = bookings.filter(isLive);

  const corporateBookings = live.filter((b) => b.corporateFareApplied).length;
  const declined = live.filter((b) => b.retailOverCorporate);
  /**
   * The denominator matters. A booking only counts as "eligible" if a corporate
   * fare was genuinely available — either it was taken, or it was declined with
   * a recorded alternative. Routes with no corporate inventory must not drag
   * the rate down, or the metric measures the network rather than behaviour.
   */
  const eligible = corporateBookings + declined.length;

  const withGstin = live.filter((b) => Boolean(b.gst?.gstin)).length;

  return {
    corporateAttachRate: eligible > 0 ? corporateBookings / eligible : null,
    corporateEligibleBookings: eligible,
    corporateBookings,
    declinedCorporate: declined.length,
    forgoneSaving: declined.reduce((s, b) => s + (b.retailOverCorporate?.forgoneSaving ?? 0), 0),
    gstinAttachRate: live.length > 0 ? withGstin / live.length : null,
    bookingsWithGstin: withGstin,
    totalBookings: live.length,
  };
}

/** FR-RPT-3 */
export function savingsSummary(bookings: Booking[]): SavingsSummary {
  const live = bookings.filter(isLive);

  const realisedCorporateSaving = live.reduce(
    (s, b) => s + (b.corporateFareApplied ? (b.offer.savingVsRetail ?? 0) : 0),
    0,
  );
  const itcRecoverable = live.reduce((s, b) => s + b.offer.landedCost.recoverableItc, 0);
  const totalPayable = live.reduce((s, b) => s + b.offer.landedCost.totalPayable, 0);
  const netCost = live.reduce((s, b) => s + b.offer.landedCost.netCost, 0);
  const totalSaving = realisedCorporateSaving + itcRecoverable;

  // What the same trips would have cost at retail with no ITC recovered.
  const counterfactual = totalPayable + realisedCorporateSaving;

  return {
    realisedCorporateSaving,
    itcRecoverable,
    totalSaving,
    totalPayable,
    netCost,
    bookingCount: live.length,
    averageSavingPerBooking: live.length > 0 ? Math.round(totalSaving / live.length) : 0,
    savingRatePct: counterfactual > 0 ? (totalSaving / counterfactual) * 100 : null,
  };
}

/** FR-SVC-3 — unused ticket value, which expires if nobody watches it. */
export function creditShells(bookings: Booking[]): CreditShellSummary {
  const shells = bookings
    .map((b) => b.creditShell)
    .filter((c): c is NonNullable<typeof c> => Boolean(c) && !c!.consumed);

  const horizon = Date.now() + 90 * 86_400_000;
  const byCarrier = new Map<CarrierCode, { amount: number; count: number }>();
  for (const s of shells) {
    const entry = byCarrier.get(s.carrier) ?? { amount: 0, count: 0 };
    entry.amount += s.amount;
    entry.count += 1;
    byCarrier.set(s.carrier, entry);
  }

  return {
    totalHeld: shells.reduce((s, c) => s + c.amount, 0),
    count: shells.length,
    expiringWithin90Days: shells.filter((c) => new Date(c.expiresAt).getTime() < horizon).length,
    byCarrier: [...byCarrier.entries()].map(([carrier, v]) => ({ carrier, ...v })),
  };
}

/** FR-RPT-6 — corporate query health, from search leg telemetry. */
export function legHealth(telemetry: LegTelemetry[]): LegHealthRow[] {
  const byKey = new Map<string, LegHealthRow>();
  for (const t of telemetry) {
    const key = `${t.carrier}:${t.fareType}`;
    const row =
      byKey.get(key) ??
      ({ carrier: t.carrier, fareType: t.fareType, total: 0, successRate: 0, outcomes: {} } as LegHealthRow);
    row.outcomes[t.outcome] = (row.outcomes[t.outcome] ?? 0) + 1;
    row.total += 1;
    byKey.set(key, row);
  }
  for (const row of byKey.values()) {
    const ok = (row.outcomes['SUCCESS'] ?? 0) + (row.outcomes['NO_INVENTORY'] ?? 0);
    row.successRate = row.total > 0 ? ok / row.total : 0;
  }
  return [...byKey.values()].sort((a, b) => a.carrier.localeCompare(b.carrier));
}

export interface Dashboard {
  attach: AttachRates;
  savings: SavingsSummary;
  credits: CreditShellSummary;
  legs: LegHealthRow[];
  /** Plain-language read of what the numbers mean, shown above the tables. */
  headlines: string[];
}

export function dashboard(bookings: Booking[], telemetry: LegTelemetry[]): Dashboard {
  const attach = attachRates(bookings);
  const savings = savingsSummary(bookings);
  const credits = creditShells(bookings);
  const legs = legHealth(telemetry);

  const headlines: string[] = [];

  if (attach.gstinAttachRate !== null && attach.gstinAttachRate < 1) {
    headlines.push(
      `GSTIN attach rate is ${(attach.gstinAttachRate * 100).toFixed(1)}%. It should be 100% — ` +
        `GST cannot be added after ticketing, so every gap is permanently lost credit.`,
    );
  }
  if (attach.declinedCorporate > 0) {
    headlines.push(
      `${attach.declinedCorporate} booking(s) declined an available corporate fare, forgoing ` +
        `₹${Math.round(attach.forgoneSaving / 100).toLocaleString('en-IN')} in savings.`,
    );
  }
  const brokenLegs = legs.filter((l) => l.fareType === 'CORPORATE' && l.successRate < 0.99);
  if (brokenLegs.length > 0) {
    headlines.push(
      `Corporate fare queries are failing for ${brokenLegs.map((l) => l.carrier).join(', ')}. ` +
        `Travellers see retail prices for those carriers, and the attach rate below understates the problem.`,
    );
  }
  if (credits.expiringWithin90Days > 0) {
    headlines.push(
      `${credits.expiringWithin90Days} credit shell(s) expire within 90 days — unused value that lapses if not rebooked.`,
    );
  }
  if (headlines.length === 0 && savings.bookingCount > 0) {
    headlines.push('No leakage detected: every booking carried a GSTIN and took the corporate fare where one existed.');
  }

  return { attach, savings, credits, legs, headlines };
}
