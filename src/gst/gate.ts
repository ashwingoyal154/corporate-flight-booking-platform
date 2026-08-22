import type { GstSubmission, LegalEntity, Segment } from '../domain/types.js';
import { GstRequiredError } from '../domain/errors.js';
import { normaliseGstin, validateGstin } from '../domain/gstin.js';
import { AIRPORT_BY_CODE } from '../supply/mock/fixtures.js';

/**
 * GST gate — FR-GST-1, FR-GST-2, CON-4.
 *
 * This is the single highest-ROI requirement in the product. GST input tax
 * credit is worth ~4.8% of all-in economy cost (~₹12 lakh/year at this client's
 * volume, research.md §5.3), it needs no airline contract, and it CANNOT be
 * fixed after ticketing — a missing or mistyped GSTIN loses the credit
 * permanently.
 *
 * So: booking is hard-blocked without valid GST details, the details are
 * pre-filled from configuration, and a traveller can never free-text a GSTIN.
 */
export function buildGstSubmission(entity: LegalEntity): GstSubmission {
  // FR-GST-2: pre-filled from the session's configured legal entity. There is
  // deliberately no code path that accepts a caller-supplied GSTIN.
  return {
    gstin: normaliseGstin(entity.gstin),
    legalName: entity.registeredName,
    stateCode: entity.stateCode,
    email: entity.invoiceEmail,
    submittedAt: new Date().toISOString(),
  };
}

/** Hard block (FR-GST-1). Called before any provider booking call. */
export function assertBookable(gst: GstSubmission | undefined): asserts gst is GstSubmission {
  const errors: string[] = [];
  if (!gst) {
    throw new GstRequiredError(['No GST details were supplied']);
  }
  const validation = validateGstin(gst.gstin);
  if (!validation.valid) errors.push(...validation.errors);
  if (!gst.legalName?.trim()) {
    errors.push('Registered legal name is required and must match the GST portal exactly');
  }
  if (!gst.stateCode?.trim()) errors.push('State code is required');
  if (errors.length > 0) throw new GstRequiredError(errors);
}

export interface PlaceOfSupplyCheck {
  mismatch: boolean;
  entityStateCode: string;
  supplyStateCode?: string;
  message?: string;
}

/**
 * Place-of-supply warning.
 *
 * If the entity's GSTIN state differs from the place of supply, the airline may
 * issue CGST/SGST for a state where the company holds no registration — and
 * that credit is unusable (research.md §5.2). Flagged as a warning here;
 * FR-GST-3 makes it a first-class check in Stage 4.
 */
export function checkPlaceOfSupply(
  entity: LegalEntity,
  segments: Segment[],
): PlaceOfSupplyCheck {
  const first = segments[0];
  const originState = first ? AIRPORT_BY_CODE.get(first.origin)?.stateCode : undefined;
  if (!originState) return { mismatch: false, entityStateCode: entity.stateCode };
  if (originState === entity.stateCode) {
    return { mismatch: false, entityStateCode: entity.stateCode, supplyStateCode: originState };
  }
  return {
    mismatch: true,
    entityStateCode: entity.stateCode,
    supplyStateCode: originState,
    message:
      `The billing entity is registered in state ${entity.stateCode} but this journey departs from a ` +
      `state ${originState} airport. Verify the airline issues IGST — CGST/SGST from a state where ` +
      `the company holds no registration cannot be claimed.`,
  };
}
