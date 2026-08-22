import { randomBytes, randomUUID } from 'node:crypto';

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function correlationId(): string {
  return `cor_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Human-quotable booking reference (Stage 2).
 *
 * Closes the CON-10 hole: bookings are session-scoped, but a closed browser tab
 * must not strand a booking nobody can reach. Ambiguous characters are excluded
 * so it survives being read aloud over a phone.
 */
const REFERENCE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY3456789';

export function bookingReference(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += REFERENCE_ALPHABET[bytes[i]! % REFERENCE_ALPHABET.length];
  }
  return `CFB-${out}`;
}

export function pnr(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += REFERENCE_ALPHABET[bytes[i]! % REFERENCE_ALPHABET.length];
  }
  return out;
}

export function ticketNumber(carrierNumeric: string): string {
  const n = randomBytes(5).readUIntBE(0, 5) % 10_000_000_000;
  return `${carrierNumeric}-${String(n).padStart(10, '0')}`;
}
