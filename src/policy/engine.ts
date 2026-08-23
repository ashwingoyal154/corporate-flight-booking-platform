import type {
  FareOffer,
  PolicyBreach,
  PolicyEvaluation,
  PolicyRule,
  SearchCriteria,
  TravelPolicy,
} from '../domain/types.js';
import { CARRIER_NAMES } from '../domain/types.js';
import { formatInr } from '../domain/money.js';

/**
 * Policy engine — FR-POL-2, FR-POL-3.
 *
 * v1 evaluates every offer against a SINGLE default policy. Grade- and
 * band-based rules (FR-POL-1) and per-client engagement overrides (FR-POL-6)
 * need identity, which does not exist yet (CON-10), so they land with auth.
 *
 * Design note: policy is evaluated at SEARCH time, not at checkout. Discovering
 * at payment that a fare was never bookable wastes the traveller's time and is
 * a documented reason people abandon corporate tools.
 */

const SOFT_FIRST = (a: PolicyBreach, b: PolicyBreach): number =>
  a.enforcement === b.enforcement ? 0 : a.enforcement === 'HARD' ? -1 : 1;

export function defaultPolicy(policies: TravelPolicy[]): TravelPolicy | undefined {
  return policies.find((p) => p.isDefault) ?? policies[0];
}

function daysUntil(departsAt: string, now: number): number {
  return Math.floor((new Date(departsAt).getTime() - now) / 86_400_000);
}

function evaluateRule(
  rule: PolicyRule,
  offer: FareOffer,
  now: number,
): PolicyBreach | null {
  switch (rule.kind) {
    case 'MAX_FARE': {
      if (rule.cabin && rule.cabin !== offer.cabin) return null;
      /**
       * Compared against LANDED cost, not the headline fare — consistent with
       * FR-DISP-3. A cap applied to the sticker price would reject the fare
       * that actually costs the company less once ITC is recovered.
       */
      if (offer.landedCost.netCost <= rule.amount) return null;
      return {
        rule: 'MAX_FARE',
        enforcement: rule.enforcement,
        message:
          `Net cost ${formatInr(offer.landedCost.netCost)} exceeds the ` +
          `${formatInr(rule.amount)} cap for this route type.`,
      };
    }
    case 'CABIN': {
      if (rule.allowed.includes(offer.cabin)) return null;
      return {
        rule: 'CABIN',
        enforcement: rule.enforcement,
        message: `${offer.cabin} cabin is not permitted (allowed: ${rule.allowed.join(', ')}).`,
      };
    }
    case 'ADVANCE_PURCHASE': {
      const first = offer.segments[0];
      if (!first) return null;
      const days = daysUntil(first.departsAt, now);
      if (days >= rule.minDays) return null;
      return {
        rule: 'ADVANCE_PURCHASE',
        enforcement: rule.enforcement,
        message:
          `Booked ${days} day(s) before departure; policy asks for at least ${rule.minDays}. ` +
          `Late bookings cost materially more.`,
      };
    }
    case 'PREFERRED_CARRIER': {
      if (rule.carriers.includes(offer.carrier)) return null;
      return {
        rule: 'PREFERRED_CARRIER',
        enforcement: rule.enforcement,
        message:
          `${CARRIER_NAMES[offer.carrier]} is not a preferred carrier ` +
          `(${rule.carriers.map((c) => CARRIER_NAMES[c]).join(', ')}).`,
      };
    }
  }
}

export function evaluateOffer(
  offer: FareOffer,
  policy: TravelPolicy,
  now = Date.now(),
): PolicyEvaluation {
  const breaches = policy.rules
    .map((r) => evaluateRule(r, offer, now))
    .filter((b): b is PolicyBreach => b !== null)
    .sort(SOFT_FIRST);

  const blocked = breaches.some((b) => b.enforcement === 'HARD');

  return {
    policyId: policy.id,
    compliant: breaches.length === 0,
    breaches,
    blocked,
    // A hard breach cannot be justified away — only soft breaches can.
    requiresJustification: !blocked && breaches.length > 0,
  };
}

export function annotateOffers(
  offers: FareOffer[],
  policy: TravelPolicy | undefined,
  now = Date.now(),
): FareOffer[] {
  if (!policy) return offers;
  for (const offer of offers) offer.policy = evaluateOffer(offer, policy, now);
  return offers;
}

/** Unused in v1 search, but the shape approvals will need in Stage 6. */
export function summarise(evaluation: PolicyEvaluation): string {
  if (evaluation.compliant) return 'In policy';
  if (evaluation.blocked) return 'Blocked by policy';
  return `Out of policy — ${evaluation.breaches.length} issue(s), justification required`;
}
