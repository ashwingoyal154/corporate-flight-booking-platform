/**
 * Domain model — spec.md §5
 *
 * Constraint references (CON-n) and requirement references (FR-x-n) in this file
 * point at spec.md. They are load-bearing: do not remove a constraint reference
 * without removing the constraint from the spec first.
 */

// ---------------------------------------------------------------------------
// Organisation & configuration
// ---------------------------------------------------------------------------

/** Carrier codes we model. Indian domestic. */
export type CarrierCode = '6E' | 'AI' | 'QP' | 'SG';

export const CARRIER_NAMES: Record<CarrierCode, string> = {
  '6E': 'IndiGo',
  AI: 'Air India',
  QP: 'Akasa Air',
  SG: 'SpiceJet',
};

/**
 * GSTIN is per legal entity per state, not per organisation (spec.md §5).
 * `registeredName` must match the GST portal exactly — a mismatch requires
 * re-booking the ticket, it cannot be corrected (CON-4).
 */
export interface LegalEntity {
  id: string;
  name: string;
  gstin: string;
  registeredName: string;
  stateCode: string;
  invoiceEmail: string;
  address: string;
}

/**
 * How a corporate fare is unlocked, per carrier (CON-7).
 *
 * CREDENTIAL   — a separately provisioned Agency ID/PCC. IndiGo works this way:
 *                corporate and retail cannot be combined (CON-1).
 * ACCOUNT_CODE — a code sent in the shopping request (full-service carriers).
 * PROMO_CODE   — a promo code (Akasa SME).
 * CONTRACT_CODE— a negotiated contract/rule id.
 */
export type CorporateFareMechanism =
  | 'CREDENTIAL'
  | 'ACCOUNT_CODE'
  | 'PROMO_CODE'
  | 'CONTRACT_CODE';

/**
 * Corporate fare identity is configuration, never code (CON-7) — both the supply
 * partner (DEC-1) and the sourcing model (DEC-3) may change.
 *
 * NOTE the separation of `code` and `tourCode` (CON-3): the account/promo code
 * unlocks the fare at SEARCH time; the tour code is written onto the ticket at
 * TICKETING time. They are different things and are configured separately.
 */
export interface CorporateFareConfig {
  carrier: CarrierCode;
  mechanism: CorporateFareMechanism;
  /** Reference to a secret, never the secret itself (FR-ORG-3). */
  credentialRef: string;
  /** Search-time retrieval key (CON-3). Absent for pure CREDENTIAL mechanisms. */
  code?: string;
  /** Ticket-time documentation (CON-3). Never used for retrieval. */
  tourCode?: string;
  activeFrom: string;
  activeTo?: string;
}

export interface Organisation {
  id: string;
  name: string;
  legalEntities: LegalEntity[];
  corporateFareConfigs: CorporateFareConfig[];
  /** GST rates are configuration, never hardcoded (FR-GST-5, DEC-6). */
  gstRates: GstRates;
  /** How offers are ordered (FR-DISP-3). */
  rankingPolicy: RankingPolicy;
  /** Cost centres and project codes for allocation (FR-ORG-4). */
  costCentres: CostCentre[];
  projects: Project[];
  /** Travel policies. v1 evaluates against the default only (CON-10). */
  policies: TravelPolicy[];
  /** Our own GSTIN, as the agent raising the service-fee invoice (FR-GST-4). */
  agentGstin: string;
  /** Agent service fee per booking, in paise. Attracts GST at 18%. */
  serviceFeePerBooking: number;
}

/**
 * Ranking policy — FR-DISP-3.
 *
 * `changeProbability` weights each offer's change-fee exposure into its ranking
 * score. Consulting trips change often, so a fare that is ₹200 cheaper but
 * ₹2,500 more expensive to change is usually the worse buy.
 *
 * NOTE: 0.25 is an ASSUMPTION, not a measurement. The nudge-benchmark research
 * never ran (research.md §0), so this is a starting value to be calibrated
 * against real change rates once the tool has history. It is configuration
 * precisely so it can be corrected without a deploy.
 */
export interface RankingPolicy {
  changeProbability: number;
}

/**
 * As of spec date: 5% economy, 18% premium. UNVERIFIED against a primary CBIC
 * notification (DEC-6) — which is exactly why this is configuration.
 */
export interface GstRates {
  economy: number;
  premium: number;
}

// ---------------------------------------------------------------------------
// Allocation — FR-ORG-4, FR-BOOK-1
// ---------------------------------------------------------------------------

export interface CostCentre {
  code: string;
  name: string;
  active: boolean;
}

/**
 * A consulting engagement. Travel is usually rebilled to the client, so the
 * project code is what makes a booking recoverable rather than overhead.
 */
export interface Project {
  code: string;
  name: string;
  clientName: string;
  /** Whether travel on this project is rebilled to the client. */
  clientBillable: boolean;
  active: boolean;
}

/** Captured on every booking (FR-BOOK-1). */
export interface Allocation {
  projectCode: string;
  costCentreCode: string;
  clientBillable: boolean;
}

// ---------------------------------------------------------------------------
// Policy — FR-POL-2, FR-POL-3
// ---------------------------------------------------------------------------

/**
 * SOFT  — bookable, but the traveller must record a justification.
 * HARD  — blocked outright.
 *
 * Most corporate policy is soft in practice: a blanket block on a legitimate
 * late booking pushes people out of the tool entirely, which costs more than
 * the overspend (the leakage problem in research.md's brief).
 */
export type PolicyEnforcement = 'SOFT' | 'HARD';

export type PolicyRule =
  | { kind: 'MAX_FARE'; enforcement: PolicyEnforcement; amount: number; cabin?: CabinClass }
  | { kind: 'CABIN'; enforcement: PolicyEnforcement; allowed: CabinClass[] }
  | { kind: 'ADVANCE_PURCHASE'; enforcement: PolicyEnforcement; minDays: number }
  | { kind: 'PREFERRED_CARRIER'; enforcement: PolicyEnforcement; carriers: CarrierCode[] };

export interface TravelPolicy {
  id: string;
  name: string;
  isDefault: boolean;
  rules: PolicyRule[];
}

export interface PolicyBreach {
  rule: PolicyRule['kind'];
  enforcement: PolicyEnforcement;
  message: string;
}

export interface PolicyEvaluation {
  policyId: string;
  compliant: boolean;
  breaches: PolicyBreach[];
  /** True when any breach is HARD — the offer cannot be booked at all. */
  blocked: boolean;
  /** True when a justification is required to proceed (soft breach only). */
  requiresJustification: boolean;
}

// ---------------------------------------------------------------------------
// Session — v1 identity substitute (CON-10)
// ---------------------------------------------------------------------------

/**
 * v1 has no authentication. A booking is scoped to a session (CON-10).
 * `Booking.ownerRef` is reserved for the migration when auth lands (DEC-7).
 */
export interface Session {
  id: string;
  legalEntityId: string;
  createdAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type CabinClass = 'ECONOMY' | 'PREMIUM';

export interface SearchCriteria {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  passengers: number;
  cabin: CabinClass;
}

export type FareType = 'RETAIL' | 'CORPORATE';

export interface Segment {
  carrier: CarrierCode;
  flightNumber: string;
  origin: string;
  destination: string;
  departsAt: string;
  arrivesAt: string;
  durationMinutes: number;
}

/**
 * Proof that a corporate fare was actually applied (FR-SRCH-5).
 *
 * These come from the provider response. Without them we cannot build the
 * "you booked the corporate fare / you didn't" loop that all savings reporting
 * and every nudge depends on. Persisted onto the Booking (FR-BOOK-6).
 */
export interface CorporateProof {
  privateFare: boolean;
  negotiatedFare: boolean;
  pseudoCityCode?: string;
  /** Which configured mechanism produced this offer. */
  mechanism: CorporateFareMechanism;
  /** Redacted credential reference — never the secret (FR-ORG-3). */
  credentialRef: string;
}

export interface Price {
  /** Base fare before taxes, in paise to avoid float drift. */
  baseFare: number;
  /** Carrier-imposed taxes and fees, excluding GST. */
  taxesAndFees: number;
  gstRate: number;
  gstAmount: number;
  /** What the customer actually pays. */
  total: number;
}

/**
 * Landed cost (FR-DISP-2) — the number that should drive decisions.
 *
 * ITC recovery is ~4.8% of all-in economy cost (research.md §5.3), which is the
 * same order as the entire corporate fare discount. A corporate fare with a
 * worse headline price can legitimately be the cheaper option once ITC and
 * change-fee exposure are counted.
 */
export interface LandedCost {
  totalPayable: number;
  recoverableItc: number;
  netCost: number;
  changeFee: number;
  cancelFee: number;
}

export interface FareOffer {
  id: string;
  carrier: CarrierCode;
  fareType: FareType;
  fareBrand: string;
  segments: Segment[];
  price: Price;
  landedCost: LandedCost;
  /** Present only when fareType === 'CORPORATE' (FR-SRCH-5). */
  corporateProof?: CorporateProof;
  /** Included items, e.g. cabin bag, meal, seat selection. */
  inclusions: string[];
  cabin: CabinClass;
  /** Set on corporate offers when a comparable retail offer exists (FR-DISP-1). */
  retailComparatorId?: string;
  savingVsRetail?: number;
  /**
   * Set on RETAIL offers when a corporate fare exists on the same flight.
   * This is what makes FR-DISP-4 possible: choosing this offer means declining
   * a corporate fare that was actually available, and that needs a reason.
   */
  corporateAlternativeId?: string;
  corporateAlternativeSaving?: number;
  /** Landed cost plus weighted change exposure — the sort key (FR-DISP-3). */
  rankingScore?: number;
  /** Human-readable reason this offer ranks where it does (FR-DISP-3). */
  rankingReasons?: string[];
  /** Policy verdict, attached at search time (FR-POL-2). */
  policy?: PolicyEvaluation;
}

/**
 * Outcome of one leg of the dual search (FR-SRCH-4).
 *
 * The whole point: a failed corporate query must NEVER render as "no corporate
 * fare available". That failure mode looks healthy while delivering nothing.
 */
export type LegOutcome =
  | 'SUCCESS'
  | 'NO_INVENTORY'
  | 'AUTH_FAILURE'
  | 'TIMEOUT'
  | 'MISCONFIGURED'
  | 'PROVIDER_ERROR';

export interface LegResult {
  carrier: CarrierCode;
  fareType: FareType;
  outcome: LegOutcome;
  offerCount: number;
  durationMs: number;
  message?: string;
}

export interface SearchResult {
  searchId: string;
  criteria: SearchCriteria;
  offers: FareOffer[];
  legs: LegResult[];
  /** True when at least one leg did not resolve inside the budget (FR-SRCH-7). */
  partial: boolean;
  elapsedMs: number;
  /**
   * True when a corporate leg failed for a reason that is OUR fault, not the
   * airline's. Drives the "we could not check corporate fares" message rather
   * than "no corporate fare available" (FR-SRCH-4).
   */
  corporateUnavailableDueToFailure: boolean;
}

// ---------------------------------------------------------------------------
// Hold & booking
// ---------------------------------------------------------------------------

export type HoldStatus = 'HELD' | 'CONSUMED' | 'EXPIRED';

/** A selected fare is held for 5 minutes (CON-12, FR-BOOK-9). */
export interface FareHold {
  id: string;
  offer: FareOffer;
  sessionId: string;
  heldAt: string;
  expiresAt: string;
  status: HoldStatus;
}

export interface PassengerDetails {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  email: string;
  phone: string;
}

/** GST details submitted with a booking (CON-5, FR-GST-1). */
export interface GstSubmission {
  gstin: string;
  legalName: string;
  stateCode: string;
  email: string;
  submittedAt: string;
}

export type BookingStatus =
  | 'HELD'
  | 'TICKETED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'FAILED';

export interface AuditEntry {
  at: string;
  /** In v1 this is the session id (CON-10, NFR-3). Becomes a user when auth lands. */
  actor: string;
  action: string;
  correlationId: string;
  detail?: Record<string, unknown>;
}

export interface Booking {
  id: string;
  /** Human-quotable retrieval code — closes the CON-10 session-scoping hole. */
  reference: string;
  /** v1 owner (CON-10). */
  sessionId: string;
  /** Reserved for the auth migration (DEC-7). Nullable from day one. */
  ownerRef: string | null;
  pnr: string;
  ticketNumbers: string[];
  supplyProvider: string;
  credentialRef: string;
  /** Immutable record of exactly what was sold. */
  offer: FareOffer;
  passengers: PassengerDetails[];
  gst: GstSubmission;
  /** Provider-issued token only. Never card data (CON-13). */
  paymentToken: string;
  corporateFareApplied: boolean;
  status: BookingStatus;
  createdAt: string;
  cancelledAt?: string;
  cancellationFee?: number;
  refundAmount?: number;
  /**
   * Why a retail fare was chosen when a corporate one was available (FR-DISP-4).
   * Null when the question did not arise. Never silently absent when it did.
   */
  retailOverCorporate?: RetailOverCorporate;
  /** Unused ticket value held with the carrier after cancellation (FR-SVC-3). */
  creditShell?: CreditShell;
  /** Both invoices, captured per booking (FR-GST-4). */
  invoices: InvoiceRecord[];
  /** Mandatory allocation (FR-BOOK-1). */
  allocation: Allocation;
  /** The policy verdict at the time of booking (FR-POL-2). */
  policyEvaluation?: PolicyEvaluation;
  /** Why an out-of-policy booking was allowed to proceed (FR-POL-3). */
  policyJustification?: string;
  audit: AuditEntry[];
}

/** FR-DISP-4 — declining an available corporate fare is a recorded decision. */
export interface RetailOverCorporate {
  corporateOfferId: string;
  forgoneSaving: number;
  reason: string;
  recordedAt: string;
}

/**
 * FR-SVC-3 — a cancelled ticket usually leaves value with the carrier rather
 * than returning cash. Untracked, that value silently expires.
 */
export interface CreditShell {
  amount: number;
  carrier: CarrierCode;
  issuedAt: string;
  expiresAt: string;
  consumed: boolean;
}

/**
 * FR-GST-4 — two invoices exist per booking and both are needed for full
 * recovery: the AIRLINE's tax invoice for the fare (from which ITC on the fare
 * flows) and the AGENT's invoice for service fees. research.md §5.4.
 */
export interface InvoiceRecord {
  kind: 'AIRLINE_FARE' | 'AGENT_SERVICE_FEE';
  invoiceNumber: string;
  supplierGstin: string;
  recipientGstin: string;
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  total: number;
  issuedAt: string;
}

/** Per-booking savings record (spec.md §5). Feeds Stage 3 reporting. */
export interface SavingsRecord {
  bookingId: string;
  retailComparator: number | null;
  corporateDelta: number;
  itcRecoverable: number;
}
