import type {
  CarrierCode,
  CorporateFareConfig,
  FareOffer,
  FareType,
  LegOutcome,
  LegResult,
  Organisation,
  SearchCriteria,
  SearchResult,
} from '../domain/types.js';
import { ProviderError, type SupplyCredential, type SupplyProvider } from '../supply/port.js';
import { priceOffer } from './pricing.js';
import { correlationId, id } from '../domain/ids.js';
import { store, type LegTelemetry } from '../store/store.js';
import { CARRIER_NAMES } from '../domain/types.js';

/**
 * Search budget in milliseconds (CON-11, FR-SRCH-9).
 *
 * A hard wall-clock deadline, not a target. Whatever has resolved at the
 * deadline is returned; unresolved legs are recorded as TIMEOUT (FR-SRCH-4).
 */
export const SEARCH_BUDGET_MS = 5_000;

const ALL_CARRIERS: CarrierCode[] = ['6E', 'AI', 'QP', 'SG'];

/** Retail credentials are the default provisioning; corporate ones come from config (CON-7). */
function retailCredential(carrier: CarrierCode): SupplyCredential {
  return { ref: `secret://supply/${carrier.toLowerCase()}/retail`, fareScope: 'RETAIL' };
}

function corporateCredential(cfg: CorporateFareConfig): SupplyCredential {
  return { ref: cfg.credentialRef, fareScope: 'CORPORATE' };
}

function activeCorporateConfig(
  org: Organisation,
  carrier: CarrierCode,
  onDate: Date,
): CorporateFareConfig | undefined {
  return org.corporateFareConfigs.find((c) => {
    if (c.carrier !== carrier) return false;
    if (new Date(c.activeFrom) > onDate) return false;
    if (c.activeTo && new Date(c.activeTo) < onDate) return false;
    return true;
  });
}

interface LegPlan {
  carrier: CarrierCode;
  fareType: FareType;
  credential: SupplyCredential;
  config?: CorporateFareConfig;
}

/**
 * Classifies a leg failure (FR-SRCH-4).
 *
 * The distinction that matters: NO_INVENTORY means the airline had nothing to
 * sell. Everything else means WE failed. Only the first justifies telling the
 * user no corporate fare exists.
 */
function classify(err: unknown): { outcome: LegOutcome; message: string } {
  if (err instanceof ProviderError) return { outcome: err.kind, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'aborted' || message.includes('abort')) {
    return { outcome: 'TIMEOUT', message: 'Leg did not resolve within the search budget' };
  }
  return { outcome: 'PROVIDER_ERROR', message };
}

/** Outcomes that mean our plumbing failed, not that the airline had no seats. */
const OUR_FAULT: LegOutcome[] = ['AUTH_FAILURE', 'TIMEOUT', 'MISCONFIGURED', 'PROVIDER_ERROR'];

export class SearchOrchestrator {
  constructor(
    private readonly provider: SupplyProvider,
    private readonly org: Organisation,
  ) {}

  /**
   * Runs the dual search (FR-SRCH-1).
   *
   * Corporate fares never appear alongside retail in one response (CON-2), and
   * for IndiGo they are gated by a separate credential entirely (CON-1). So
   * every carrier is queried TWICE, in parallel, and the results are merged
   * here rather than by the provider.
   */
  async search(criteria: SearchCriteria): Promise<SearchResult> {
    const searchId = id('sch');
    const cid = correlationId();
    const startedAt = Date.now();
    const now = new Date();

    const plans: LegPlan[] = [];
    for (const carrier of ALL_CARRIERS) {
      // FR-SRCH-2: retail is always retrieved, even when a corporate fare
      // exists — it is the comparator that makes savings measurable.
      plans.push({ carrier, fareType: 'RETAIL', credential: retailCredential(carrier) });

      const cfg = activeCorporateConfig(this.org, carrier, now);
      if (cfg) {
        plans.push({
          carrier,
          fareType: 'CORPORATE',
          credential: corporateCredential(cfg),
          config: cfg,
        });
      }
    }

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), SEARCH_BUDGET_MS);

    const settled = await Promise.all(
      plans.map(async (plan): Promise<{ plan: LegPlan; leg: LegResult; offers: FareOffer[] }> => {
        const legStart = Date.now();
        try {
          const providerOffers = await this.provider.search({
            criteria,
            carrier: plan.carrier,
            credential: plan.credential,
            fareScope: plan.fareType,
            // FR-SRCH-6: restrict the response to corporate content so we get
            // "only corporate came back" rather than "it's in there somewhere".
            accountCodeFaresOnly: plan.fareType === 'CORPORATE',
            ...(plan.config?.code ? { code: plan.config.code } : {}),
            ...(plan.config ? { mechanism: plan.config.mechanism } : {}),
            signal: controller.signal,
          });

          const offers = providerOffers.map((po) => {
            const { price, landedCost } = priceOffer(po, this.org.gstRates, criteria.cabin);
            const offer: FareOffer = {
              id: po.providerOfferId,
              carrier: po.carrier,
              fareType: po.fareType,
              fareBrand: po.fareBrand,
              segments: po.segments,
              price,
              landedCost,
              inclusions: po.inclusions,
              cabin: po.cabin,
              ...(po.fareType === 'CORPORATE' && plan.config
                ? {
                    // FR-SRCH-5 — persisted onto the booking (FR-BOOK-6).
                    corporateProof: {
                      privateFare: po.privateFare ?? false,
                      negotiatedFare: po.negotiatedFare ?? false,
                      ...(po.pseudoCityCode ? { pseudoCityCode: po.pseudoCityCode } : {}),
                      mechanism: plan.config.mechanism,
                      credentialRef: plan.config.credentialRef,
                    },
                  }
                : {}),
            };
            return offer;
          });

          return {
            plan,
            leg: {
              carrier: plan.carrier,
              fareType: plan.fareType,
              outcome: offers.length > 0 ? 'SUCCESS' : 'NO_INVENTORY',
              offerCount: offers.length,
              durationMs: Date.now() - legStart,
            },
            offers,
          };
        } catch (err) {
          const { outcome, message } = classify(err);
          return {
            plan,
            leg: {
              carrier: plan.carrier,
              fareType: plan.fareType,
              outcome,
              offerCount: 0,
              durationMs: Date.now() - legStart,
              message,
            },
            offers: [],
          };
        }
      }),
    );

    clearTimeout(deadline);

    const legs = settled.map((s) => s.leg);
    const offers = settled.flatMap((s) => s.offers);

    this.attachRetailComparators(offers);

    const partial = legs.some((l) => l.outcome === 'TIMEOUT');

    /**
     * FR-SRCH-4, the point of Stage 2.
     *
     * If a corporate leg failed for a reason that is our fault, the UI must say
     * "we could not check corporate fares" — never "no corporate fare
     * available". The second phrasing looks healthy while delivering nothing,
     * and it is the failure mode that quietly destroys the whole thesis.
     */
    const corporateUnavailableDueToFailure = legs.some(
      (l) => l.fareType === 'CORPORATE' && OUR_FAULT.includes(l.outcome),
    );

    const route = `${criteria.origin}-${criteria.destination}`;
    const at = new Date().toISOString();
    store.recordLegs(legs.map((l): LegTelemetry => ({ ...l, at, searchId, route })));
    this.raiseAlerts(legs, route, cid);

    return {
      searchId,
      criteria,
      offers,
      legs,
      partial,
      elapsedMs: Date.now() - startedAt,
      corporateUnavailableDueToFailure,
    };
  }

  /**
   * Pairs each corporate offer with the comparable retail offer on the same
   * flight (FR-DISP-1), so the saving shown is a real like-for-like delta and
   * not a marketing percentage.
   */
  private attachRetailComparators(offers: FareOffer[]): void {
    const retailByFlight = new Map<string, FareOffer>();
    for (const o of offers) {
      if (o.fareType !== 'RETAIL') continue;
      const key = o.segments.map((s) => s.flightNumber).join('+');
      retailByFlight.set(key, o);
    }
    for (const o of offers) {
      if (o.fareType !== 'CORPORATE') continue;
      const key = o.segments.map((s) => s.flightNumber).join('+');
      const retail = retailByFlight.get(key);
      if (!retail) continue;
      o.retailComparatorId = retail.id;
      o.savingVsRetail = retail.price.total - o.price.total;
    }
  }

  /** Stage 2: a corporate leg failing for our own reasons must reach an admin. */
  private raiseAlerts(legs: LegResult[], route: string, cid: string): void {
    for (const leg of legs) {
      if (leg.fareType !== 'CORPORATE') continue;
      if (!OUR_FAULT.includes(leg.outcome)) continue;
      store.raiseAlert({
        id: id('alr'),
        at: new Date().toISOString(),
        severity: leg.outcome === 'NO_INVENTORY' ? 'WARN' : 'ERROR',
        code: `CORPORATE_LEG_${leg.outcome}`,
        message:
          `Corporate fare query failed for ${CARRIER_NAMES[leg.carrier]} (${leg.carrier}) on ${route}. ` +
          `Travellers are seeing retail fares only for this carrier.`,
        detail: { carrier: leg.carrier, outcome: leg.outcome, message: leg.message, correlationId: cid },
        acknowledged: false,
      });
    }
  }
}
