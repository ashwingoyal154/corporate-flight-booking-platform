import type { Booking, Organisation } from '../domain/types.js';

/**
 * Finance reporting — FR-RPT-4, FR-RPT-5, FR-GST-6.
 *
 * Two jobs: allocate spend to the engagements that should carry it, and produce
 * a ledger finance can reconcile line-by-line against GSTR-2B. Post-Oct-2022
 * the ITC claim is effectively locked to what appears in 2B (research.md §5.2),
 * so a booking record that cannot be matched to a supplier filing is a credit
 * at risk.
 */

export interface SpendRow {
  key: string;
  label: string;
  bookings: number;
  totalPayable: number;
  recoverableItc: number;
  netCost: number;
  corporateFareBookings: number;
}

export interface SpendReport {
  byProject: SpendRow[];
  byCostCentre: SpendRow[];
  clientBillable: SpendRow[];
}

/** FR-RPT-5 — policy compliance across bookings. */
export interface ComplianceReport {
  total: number;
  inPolicy: number;
  outOfPolicy: number;
  complianceRate: number | null;
  breachesByRule: Array<{ rule: string; count: number }>;
  justifications: Array<{ reference: string; reason: string; breaches: string[] }>;
}

const live = (b: Booking): boolean => b.status === 'TICKETED';

function accumulate(
  bookings: Booking[],
  keyOf: (b: Booking) => string,
  labelOf: (key: string) => string,
): SpendRow[] {
  const rows = new Map<string, SpendRow>();
  for (const b of bookings) {
    const key = keyOf(b);
    const row =
      rows.get(key) ??
      ({
        key,
        label: labelOf(key),
        bookings: 0,
        totalPayable: 0,
        recoverableItc: 0,
        netCost: 0,
        corporateFareBookings: 0,
      } as SpendRow);
    row.bookings += 1;
    row.totalPayable += b.offer.landedCost.totalPayable;
    row.recoverableItc += b.offer.landedCost.recoverableItc;
    row.netCost += b.offer.landedCost.netCost;
    if (b.corporateFareApplied) row.corporateFareBookings += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.totalPayable - a.totalPayable);
}

export function spendReport(bookings: Booking[], org: Organisation): SpendReport {
  const ticketed = bookings.filter(live);
  const projectName = (code: string) =>
    org.projects.find((p) => p.code === code)?.name ?? code;
  const costCentreName = (code: string) =>
    org.costCentres.find((c) => c.code === code)?.name ?? code;

  return {
    byProject: accumulate(ticketed, (b) => b.allocation.projectCode, projectName),
    byCostCentre: accumulate(ticketed, (b) => b.allocation.costCentreCode, costCentreName),
    clientBillable: accumulate(
      ticketed,
      (b) => (b.allocation.clientBillable ? 'billable' : 'internal'),
      (k) => (k === 'billable' ? 'Client billable' : 'Firm internal'),
    ),
  };
}

export function complianceReport(bookings: Booking[]): ComplianceReport {
  const ticketed = bookings.filter(live);
  const evaluated = ticketed.filter((b) => b.policyEvaluation);
  const inPolicy = evaluated.filter((b) => b.policyEvaluation!.compliant).length;

  const counts = new Map<string, number>();
  for (const b of evaluated) {
    for (const br of b.policyEvaluation!.breaches) {
      counts.set(br.rule, (counts.get(br.rule) ?? 0) + 1);
    }
  }

  return {
    total: evaluated.length,
    inPolicy,
    outOfPolicy: evaluated.length - inPolicy,
    complianceRate: evaluated.length > 0 ? inPolicy / evaluated.length : null,
    breachesByRule: [...counts.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count),
    justifications: evaluated
      .filter((b) => b.policyJustification)
      .map((b) => ({
        reference: b.reference,
        reason: b.policyJustification!,
        breaches: b.policyEvaluation!.breaches.map((x) => x.message),
      })),
  };
}

export interface Gstr2bLine {
  bookingReference: string;
  bookingDate: string;
  invoiceNumber: string;
  invoiceKind: string;
  supplierGstin: string;
  recipientGstin: string;
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  total: number;
  projectCode: string;
  costCentreCode: string;
  status: string;
  /**
   * ITC on a cancelled ticket is reversed with the refund — finance must not
   * keep claiming it. Surfacing it as a line flag prevents exactly that.
   */
  itcReversed: boolean;
}

/**
 * FR-GST-6 — a ledger that reconciles line-by-line to GSTR-2B.
 *
 * One line per invoice (not per booking), because 2B is filed per supplier
 * invoice: the airline's fare invoice and our service-fee invoice appear
 * separately and must match separately.
 */
export function gstr2bLines(bookings: Booking[]): Gstr2bLine[] {
  const lines: Gstr2bLine[] = [];
  for (const b of bookings) {
    for (const inv of b.invoices ?? []) {
      lines.push({
        bookingReference: b.reference,
        bookingDate: b.createdAt.slice(0, 10),
        invoiceNumber: inv.invoiceNumber,
        invoiceKind: inv.kind,
        supplierGstin: inv.supplierGstin,
        recipientGstin: inv.recipientGstin,
        taxableValue: inv.taxableValue,
        gstRate: inv.gstRate,
        gstAmount: inv.gstAmount,
        total: inv.total,
        projectCode: b.allocation?.projectCode ?? '',
        costCentreCode: b.allocation?.costCentreCode ?? '',
        status: b.status,
        itcReversed: b.status === 'CANCELLED' || b.status === 'REFUNDED',
      });
    }
  }
  return lines.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
}

export function gstr2bCsv(lines: Gstr2bLine[]): string {
  const header = [
    'booking_reference',
    'booking_date',
    'invoice_number',
    'invoice_kind',
    'supplier_gstin',
    'recipient_gstin',
    'taxable_value_inr',
    'gst_rate_pct',
    'gst_amount_inr',
    'total_inr',
    'project_code',
    'cost_centre_code',
    'status',
    'itc_reversed',
  ].join(',');

  const rupees = (paise: number) => (paise / 100).toFixed(2);

  const rows = lines.map((l) =>
    [
      l.bookingReference,
      l.bookingDate,
      l.invoiceNumber,
      l.invoiceKind,
      l.supplierGstin,
      l.recipientGstin,
      rupees(l.taxableValue),
      (l.gstRate * 100).toFixed(0),
      rupees(l.gstAmount),
      rupees(l.total),
      l.projectCode,
      l.costCentreCode,
      l.status,
      l.itcReversed ? 'YES' : 'NO',
    ].join(','),
  );

  return [header, ...rows].join('\n');
}
