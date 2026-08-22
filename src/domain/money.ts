/**
 * Money is integer paise everywhere. Never floats — GST arithmetic feeds an
 * input-tax-credit claim (research.md §5) and rounding drift is not acceptable
 * in something finance reconciles against GSTR-2B.
 */

export const RUPEE = 100;

export function rupees(n: number): number {
  return Math.round(n * RUPEE);
}

export function formatInr(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / RUPEE);
  // Indian digit grouping: last 3, then pairs.
  const s = String(whole);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${sign}₹${grouped}`;
}

/**
 * GST is charged on (base + carrier taxes). Recovering it as input tax credit
 * reduces net cost by gstAmount — worth ~4.8% of all-in economy cost
 * (research.md §5.3).
 */
export function computeGst(taxableValue: number, rate: number): number {
  return Math.round(taxableValue * rate);
}
