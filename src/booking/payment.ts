import { CardDataRejectedError } from '../domain/errors.js';

/**
 * Card data must never reach this server — CON-13, NFR-8.
 *
 * The browser tokenises directly with the provider; we accept, store and
 * transmit only the resulting token. Keeping card data out entirely is what
 * keeps us outside PCI-DSS cardholder-data scope, and retrofitting that is far
 * harder than never acquiring the scope.
 *
 * This guard is deliberately paranoid: it rejects the request rather than
 * stripping the fields, because silently accepting and discarding card data
 * still means the data reached the server, was in memory, and may be in an
 * access log written before this code ran.
 */

const FORBIDDEN_KEYS = [
  'cardnumber',
  'card_number',
  'pan',
  'cvv',
  'cvc',
  'cvv2',
  'securitycode',
  'security_code',
  'expiry',
  'expirymonth',
  'expiryyear',
  'exp_month',
  'exp_year',
  'cardholdername',
];

/** 13-19 digits, optionally separated — a payment card number shape. */
const PAN_SHAPE = /\b(?:\d[ -]?){13,19}\b/;

function looksLikePan(value: string): boolean {
  const digits = value.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  // Luhn — avoids flagging long non-card digit strings.
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function assertNoCardData(payload: unknown, path = '$'): void {
  const offenders: string[] = [];
  walk(payload, path, offenders);
  if (offenders.length > 0) throw new CardDataRejectedError(offenders);
}

function walk(node: unknown, path: string, offenders: string[]): void {
  if (node === null || node === undefined) return;

  if (typeof node === 'string') {
    if (PAN_SHAPE.test(node) && looksLikePan(node)) offenders.push(path);
    return;
  }
  if (typeof node === 'number') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, offenders));
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const normalised = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (FORBIDDEN_KEYS.includes(normalised)) {
        offenders.push(`${path}.${key}`);
        continue; // do not descend — we never want the value in a stack trace
      }
      walk(value, `${path}.${key}`, offenders);
    }
  }
}

/** Provider-issued tokens only. */
export function assertPaymentToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !token.startsWith('tok_') || token.length < 12) {
    throw new CardDataRejectedError(['paymentToken']);
  }
}

/** Mock tokenisation, standing in for the provider's client-side SDK. */
export function issueMockToken(): string {
  return `tok_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
