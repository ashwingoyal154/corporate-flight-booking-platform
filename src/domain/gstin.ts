/**
 * GSTIN validation — CON-5, FR-ORG-1.
 *
 * 15 alphanumeric characters with positional rules:
 *   1-2   numeric       (state code)
 *   3-7   alpha         (PAN: first five)
 *   8-11  numeric       (PAN: four digits)
 *   12    alpha         (PAN: last character)
 *   13-15 alphanumeric  (entity code, 'Z', checksum)
 *
 * This is validated at entry time (FR-ORG-1) and again before booking
 * (FR-GST-1), because a GSTIN cannot be added or corrected after ticketing
 * (CON-4) — a wrong one means the input tax credit is permanently lost.
 */

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;

export interface GstinValidation {
  valid: boolean;
  errors: string[];
  /** Derived from characters 1-2. Drives place-of-supply reasoning. */
  stateCode?: string;
}

export function validateGstin(raw: string | undefined | null): GstinValidation {
  const errors: string[] = [];
  const value = (raw ?? '').trim().toUpperCase();

  if (!value) {
    return { valid: false, errors: ['GSTIN is required'] };
  }
  if (value.length !== 15) {
    errors.push(`GSTIN must be exactly 15 characters (got ${value.length})`);
  }
  if (!/^[0-9A-Z]+$/.test(value)) {
    errors.push('GSTIN must contain only digits and uppercase letters');
  }

  // Report positional failures individually — a single "invalid GSTIN" message
  // makes admin data entry guesswork.
  if (value.length === 15) {
    if (!/^[0-9]{2}/.test(value)) errors.push('Characters 1-2 must be numeric (state code)');
    if (!/^.{2}[A-Z]{5}/.test(value)) errors.push('Characters 3-7 must be alphabetic');
    if (!/^.{7}[0-9]{4}/.test(value)) errors.push('Characters 8-11 must be numeric');
    if (!/^.{11}[A-Z]/.test(value)) errors.push('Character 12 must be alphabetic');
    if (!/^.{12}[0-9A-Z]{3}$/.test(value)) errors.push('Characters 13-15 must be alphanumeric');
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], stateCode: value.slice(0, 2) };
}

export function normaliseGstin(raw: string): string {
  return raw.trim().toUpperCase();
}
