import type { FareOffer, RankingPolicy } from '../domain/types.js';
import { formatInr } from '../domain/money.js';

/**
 * Offer ranking — FR-DISP-3.
 *
 * Ranks by LANDED cost, not headline price. This is the one nudge in the
 * product with a grounded justification: recovering GST is worth ~4.8% of the
 * all-in economy price (research.md §5.3), which is the same order as the
 * entire corporate fare discount. Sorting on headline price would therefore
 * systematically recommend the more expensive option.
 *
 * Change-fee exposure is weighted in because consulting trips change often and
 * corporate fares reduce those fees materially (CON-8) — a fare ₹200 cheaper
 * but ₹2,500 dearer to change is usually the worse buy.
 *
 * HONESTY NOTE: the weighting is an assumption. The nudge-benchmark research
 * thread never ran, so this is a hypothesis shipped with instrumentation
 * attached, not a researched design. Calibrate `changeProbability` against real
 * change rates once there is history.
 */
export function scoreOffer(offer: FareOffer, policy: RankingPolicy): number {
  const expectedChangeCost = Math.round(offer.landedCost.changeFee * policy.changeProbability);
  return offer.landedCost.netCost + expectedChangeCost;
}

export function explainRanking(offer: FareOffer, policy: RankingPolicy): string[] {
  const reasons: string[] = [];

  if (offer.landedCost.recoverableItc > 0) {
    reasons.push(`${formatInr(offer.landedCost.recoverableItc)} GST recoverable as input tax credit`);
  }
  if (offer.fareType === 'CORPORATE' && offer.savingVsRetail && offer.savingVsRetail > 0) {
    reasons.push(`${formatInr(offer.savingVsRetail)} below the retail fare on the same flight`);
  }
  if (offer.landedCost.changeFee === 0) {
    reasons.push('No change fee');
  } else {
    const expected = Math.round(offer.landedCost.changeFee * policy.changeProbability);
    reasons.push(
      `Change fee ${formatInr(offer.landedCost.changeFee)} ` +
        `(${formatInr(expected)} weighted at a ${Math.round(policy.changeProbability * 100)}% change rate)`,
    );
  }
  return reasons;
}

/**
 * Sorts offers by landed cost including change exposure.
 *
 * Deliberately returns a NEW array and annotates each offer, so the UI can show
 * the traveller why an apparently pricier fare is ranked first — an unexplained
 * reorder reads as the tool hiding the cheap option.
 */
export function rankOffers(offers: FareOffer[], policy: RankingPolicy): FareOffer[] {
  for (const offer of offers) {
    offer.rankingScore = scoreOffer(offer, policy);
    offer.rankingReasons = explainRanking(offer, policy);
  }
  return [...offers].sort((a, b) => {
    const diff = a.rankingScore! - b.rankingScore!;
    if (diff !== 0) return diff;
    // Stable, predictable tie-break: earlier departure first.
    const aDep = a.segments[0]?.departsAt ?? '';
    const bDep = b.segments[0]?.departsAt ?? '';
    return aDep.localeCompare(bDep);
  });
}

/**
 * True when this retail offer means declining a corporate fare that was
 * actually available on the same flight (FR-DISP-4).
 */
export function declinesCorporateFare(offer: FareOffer): boolean {
  return offer.fareType === 'RETAIL' && Boolean(offer.corporateAlternativeId);
}
