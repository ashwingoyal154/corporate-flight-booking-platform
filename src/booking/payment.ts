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

/**
 * Card-number detection.
 *
 * Deliberately does NOT rely on \b word boundaries. An underscore is a word
 * character, so `\b(?:\d[ -]?){13,19}\b` never matches the digits in
 * `tok_4111111111111111` — which let a raw PAN through inside an
 * innocent-looking token. Found by the end-to-end suite; the service-level
 * tests could not see it because they never exercised that field.
 *
 * Instead: pull out every maximal run of digits (tolerating single spaces or
 * hyphens as separators) and Luhn-check every 13-19 digit window inside it.
 * Luhn is what keeps ticket numbers, GSTINs and phone numbers from tripping it.
 */
const DIGIT_RUN = /\d(?:[ -]?\d){12,}/g;

/** Longest run we will scan windows within — bounds the work on huge inputs. */
const MAX_RUN_DIGITS = 32;

function luhnValid(digits: string): boolean {
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

export function containsPan(value: string): boolean {
  for (const match of value.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > MAX_RUN_DIGITS) continue;

    for (let len = 13; len <= 19; len++) {
      if (len > digits.length) break;
      for (let start = 0; start + len <= digits.length; start++) {
        if (luhnValid(digits.slice(start, start + len))) return true;
      }
    }
  }
  return false;
}

export function assertNoCardData(payload: unknown, path = '$'): void {
  const offenders: string[] = [];
  walk(payload, path, offenders);
  if (offenders.length > 0) throw new CardDataRejectedError(offenders);
}

function walk(node: unknown, path: string, offenders: string[]): void {
  if (node === null || node === undefined) return;

  if (typeof node === 'string') {
    if (containsPan(node)) offenders.push(path);
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

/**
 * Provider-issued tokens only.
 *
 * The shape check is not enough on its own: a caller can prefix a real card
 * number with `tok_` and satisfy it. So the token is scanned for a PAN too —
 * a token that contains a card number is card data, whatever it is called.
 */
export function assertPaymentToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !token.startsWith('tok_') || token.length < 12) {
    throw new CardDataRejectedError(['paymentToken']);
  }
  if (containsPan(token)) {
    throw new CardDataRejectedError(['paymentToken']);
  }
}

/** Mock tokenisation, standing in for the provider's client-side SDK. */
export function issueMockToken(): string {
  return `tok_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
