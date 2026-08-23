import type { CarrierCode, FareOffer, GstSubmission, InvoiceRecord, Organisation } from '../domain/types.js';
import { computeGst } from '../domain/money.js';

/**
 * Invoice capture — FR-GST-4.
 *
 * Two invoices exist per booking and BOTH are needed for full recovery
 * (research.md §5.4):
 *
 *   1. The AIRLINE's tax invoice for the fare. ITC on the fare flows from the
 *      airline's GSTIN, not ours — this is the big number, and the reason the
 *      GSTIN must be attached at ticketing (CON-4).
 *   2. The AGENT's invoice for the service fee, at 18%. Small, but it is ours
 *      to issue and is separately claimable.
 *
 * The classic corporate failure mode is holding only #2: the traveller booked
 * on a consumer login, the airline invoiced B2C, and ITC on the entire base
 * fare is gone.
 */

/** Mock airline GSTINs. A real integration reads these from the carrier invoice. */
const AIRLINE_GSTIN: Record<CarrierCode, string> = {
  '6E': '07AABCI2726B1ZW',
  AI: '07AACCN6194P1ZF',
  QP: '27AAKCS8095R1Z8',
  SG: '07AAECS7539K1ZL',
};

const AGENT_SERVICE_FEE_GST_RATE = 0.18;

export function buildInvoices(
  offer: FareOffer,
  gst: GstSubmission,
  org: Organisation,
  bookingReference: string,
): InvoiceRecord[] {
  const issuedAt = new Date().toISOString();

  const airline: InvoiceRecord = {
    kind: 'AIRLINE_FARE',
    invoiceNumber: `${offer.carrier}-${bookingReference.replace('CFB-', '')}`,
    supplierGstin: AIRLINE_GSTIN[offer.carrier],
    recipientGstin: gst.gstin,
    taxableValue: offer.price.baseFare + offer.price.taxesAndFees,
    gstRate: offer.price.gstRate,
    gstAmount: offer.price.gstAmount,
    total: offer.price.total,
    issuedAt,
  };

  const feeGst = computeGst(org.serviceFeePerBooking, AGENT_SERVICE_FEE_GST_RATE);
  const agent: InvoiceRecord = {
    kind: 'AGENT_SERVICE_FEE',
    invoiceNumber: `SF-${bookingReference.replace('CFB-', '')}`,
    supplierGstin: org.agentGstin,
    recipientGstin: gst.gstin,
    taxableValue: org.serviceFeePerBooking,
    gstRate: AGENT_SERVICE_FEE_GST_RATE,
    gstAmount: feeGst,
    total: org.serviceFeePerBooking + feeGst,
    issuedAt,
  };

  return [airline, agent];
}

/** Total recoverable ITC across both invoices. */
export function totalRecoverableItc(invoices: InvoiceRecord[]): number {
  return invoices.reduce((sum, i) => sum + i.gstAmount, 0);
}
