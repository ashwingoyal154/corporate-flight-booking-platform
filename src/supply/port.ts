/**
 * SupplyProvider port — spec.md §6.2, CON-6.
 *
 * The supply partner is undecided (DEC-1): Travelport direct, or an Indian
 * aggregator (Tripjack / TBO / Verteil). Every provider detail sits behind this
 * interface so stages 1-4 can be built and tested against a mock while the
 * commercial conversation proceeds.
 *
 * Implementations: MockAdapter (now) | TravelportAdapter | TripjackAdapter | TBOAdapter
 */

import type {
  CabinClass,
  CarrierCode,
  CorporateFareMechanism,
  FareType,
  GstSubmission,
  PassengerDetails,
  Price,
  SearchCriteria,
  Segment,
} from '../domain/types.js';

/**
 * A provisioned credential. For IndiGo, corporate and retail content require
 * SEPARATE Agency IDs/PCCs and cannot be combined (CON-1) — which is why the
 * credential carries its own fare scope rather than being a single shared key.
 */
export interface SupplyCredential {
  /** Reference to a secret. Never the secret itself (FR-ORG-3, NFR-6). */
  ref: string;
  /** The content this credential is provisioned to see. */
  fareScope: FareType;
}

export interface ProviderSearchRequest {
  criteria: SearchCriteria;
  carrier: CarrierCode;
  credential: SupplyCredential;
  fareScope: FareType;
  /**
   * Restrict the response to fares tied to the supplied code (FR-SRCH-6).
   * Travelport equivalent: @AccountCodeFaresOnly="true" / FaresIndicator.
   * Turns "the corporate fare is in there somewhere" into "only corporate came back".
   */
  accountCodeFaresOnly?: boolean;
  /** Search-time retrieval key (CON-3): account / promo / contract code. */
  code?: string;
  mechanism?: CorporateFareMechanism;
  signal?: AbortSignal;
}

/**
 * What the provider returns. GST and landed cost are computed by our pricing
 * layer, not the provider — the provider knows fares, we know the customer's
 * tax position.
 */
export interface ProviderOffer {
  providerOfferId: string;
  carrier: CarrierCode;
  fareType: FareType;
  fareBrand: string;
  cabin: CabinClass;
  segments: Segment[];
  baseFare: number;
  taxesAndFees: number;
  changeFee: number;
  cancelFee: number;
  inclusions: string[];
  /** Present on corporate offers (FR-SRCH-5). */
  privateFare?: boolean;
  negotiatedFare?: boolean;
  pseudoCityCode?: string;
}

export interface PricedOffer {
  providerOfferId: string;
  price: Pick<Price, 'baseFare' | 'taxesAndFees'>;
  /** True when the provider repriced the offer (drives FR-BOOK-5). */
  changed: boolean;
}

export interface ProviderBookRequest {
  providerOfferId: string;
  passengers: PassengerDetails[];
  /**
   * GST details must be present in BOTH the price call and the book call
   * (CON-5). The adapter asserts this — a booking that reaches the carrier
   * without them loses the input tax credit permanently (CON-4).
   */
  gst: GstSubmission;
  /** Provider-issued token. Card data never reaches us (CON-13). */
  paymentToken: string;
  /** Ticket-time documentation, distinct from the search-time code (CON-3). */
  tourCode?: string;
  /** Corporate traveller SSR, e.g. IndiGo SSR CPTR (FR-BOOK-4). */
  corporateTravellerSsr?: boolean;
  /**
   * Idempotency key (NFR-5). A retried book call with the same key must return
   * the original booking, never issue a second ticket (FR-BOOK-7).
   */
  idempotencyKey: string;
  correlationId: string;
}

export interface ProviderBooking {
  pnr: string;
  ticketNumbers: string[];
  /** True when this call returned a previously-issued booking (NFR-5). */
  replayed: boolean;
}

export interface CancelResult {
  cancellationFee: number;
  refundAmount: number;
}

export interface FareRules {
  changeFee: number;
  cancelFee: number;
  /** Carrier-specific free-change window in hours before departure, if any. */
  freeChangeWindowHours?: number;
  notes: string[];
}

export interface SupplyProvider {
  readonly name: string;
  search(req: ProviderSearchRequest): Promise<ProviderOffer[]>;
  price(providerOfferId: string, gst: GstSubmission): Promise<PricedOffer>;
  book(req: ProviderBookRequest): Promise<ProviderBooking>;
  cancel(pnr: string, correlationId: string): Promise<CancelResult>;
  fareRules(providerOfferId: string): Promise<FareRules>;
}

/** Provider-side failures, surfaced so the orchestrator can classify legs (FR-SRCH-4). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'AUTH_FAILURE' | 'NO_INVENTORY' | 'MISCONFIGURED' | 'PROVIDER_ERROR',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
