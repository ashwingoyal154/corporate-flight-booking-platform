/**
 * Domain errors carry the spec constraint they enforce, so a rejection is
 * traceable to the rule that caused it rather than surfacing as a generic 400.
 */

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** e.g. 'CON-1', 'FR-GST-1' — the rule being enforced. */
    readonly constraintRef: string,
    readonly status = 400,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** CON-1 — IndiGo corporate and retail fares can never be combined. */
export class MixedFareTypeError extends DomainError {
  constructor(carrier: string) {
    super(
      `Cannot combine CORPORATE and RETAIL fares for the same carrier (${carrier}). ` +
        `Corporate and retail fares are retrieved with separate credentials and cannot share a booking.`,
      'MIXED_FARE_TYPE',
      'CON-1',
      409,
      { carrier },
    );
  }
}

/** FR-GST-1 — booking is hard-blocked without a validated GSTIN. */
export class GstRequiredError extends DomainError {
  constructor(errors: string[]) {
    super(
      `Booking blocked: a valid GSTIN and registered legal name are required. ` +
        `GST details cannot be added or corrected after ticketing.`,
      'GST_REQUIRED',
      'FR-GST-1',
      422,
      { errors },
    );
  }
}

/** CON-13 — card data must never reach the server. */
export class CardDataRejectedError extends DomainError {
  constructor(fields: string[]) {
    super(
      `Request rejected: card data must never be sent to this server. ` +
        `Submit a provider-issued payment token instead.`,
      'CARD_DATA_REJECTED',
      'CON-13',
      400,
      { offendingFields: fields },
    );
  }
}

/** CON-12 — the 5-minute fare hold has lapsed. */
export class HoldExpiredError extends DomainError {
  constructor(holdId: string) {
    super(
      `The 5-minute fare hold has expired. The fare must be re-priced before booking.`,
      'HOLD_EXPIRED',
      'CON-12',
      409,
      { holdId },
    );
  }
}

/** FR-BOOK-5 — the price moved between hold and book. */
export class PriceChangedError extends DomainError {
  constructor(oldTotal: number, newTotal: number) {
    super(
      `The fare price changed between selection and booking. Explicit confirmation of the new price is required.`,
      'PRICE_CHANGED',
      'FR-BOOK-5',
      409,
      { oldTotal, newTotal },
    );
  }
}

/** FR-SVC-4 — name change is not supported at launch. */
export class NameChangeUnsupportedError extends DomainError {
  constructor() {
    super(
      `Name changes cannot be processed in-tool. Carrier name-change rules were not established for any ` +
        `Indian carrier, so this must be handled by the travel desk.`,
      'NAME_CHANGE_UNSUPPORTED',
      'FR-SVC-4',
      501,
    );
  }
}

/** FR-DISP-4 — declining an available corporate fare requires a recorded reason. */
export class JustificationRequiredError extends DomainError {
  constructor(forgoneSaving: number, corporateOfferId: string) {
    super(
      `A corporate fare was available on this flight. Choosing the retail fare forgoes a saving, ` +
        `so a reason is required before booking.`,
      'JUSTIFICATION_REQUIRED',
      'FR-DISP-4',
      422,
      { forgoneSaving, corporateOfferId },
    );
  }
}

/** FR-POL-3 — a hard policy breach cannot be justified away. */
export class PolicyBlockedError extends DomainError {
  constructor(reasons: string[]) {
    super(
      `This fare cannot be booked: it breaches a mandatory travel policy rule.`,
      'POLICY_BLOCKED',
      'FR-POL-3',
      422,
      { reasons },
    );
  }
}

/** FR-POL-3 — a soft breach is bookable, with a recorded reason. */
export class PolicyJustificationRequiredError extends DomainError {
  constructor(reasons: string[]) {
    super(
      `This fare is out of policy. A justification is required before booking.`,
      'POLICY_JUSTIFICATION_REQUIRED',
      'FR-POL-3',
      422,
      { reasons },
    );
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`, 'NOT_FOUND', '-', 404, { id });
  }
}
