import { describe, expect, it } from 'vitest';
import { assertNoCardData, assertPaymentToken, issueMockToken } from '../src/booking/payment.js';
import { CardDataRejectedError } from '../src/domain/errors.js';

/**
 * CON-13 / NFR-8 — card data must never reach the server.
 *
 * The request is REJECTED rather than sanitised: by the time a field could be
 * stripped, the data has already been received, held in memory, and may sit in
 * an access log written before our code ran.
 */
describe('CON-13 — card data is rejected, not sanitised', () => {
  it('accepts a clean payload', () => {
    expect(() =>
      assertNoCardData({ holdId: 'hold_1', paymentToken: 'tok_abc123456789', passengers: [{ firstName: 'A' }] }),
    ).not.toThrow();
  });

  it.each([
    ['cardNumber', { cardNumber: '4111111111111111' }],
    ['card_number', { card_number: '4111111111111111' }],
    ['pan', { pan: '4111111111111111' }],
    ['cvv', { cvv: '123' }],
    ['cvc', { cvc: '123' }],
    ['securityCode', { securityCode: '999' }],
    ['expiryMonth', { expiryMonth: '04' }],
    ['exp_year', { exp_year: '2030' }],
    ['cardholderName', { cardholderName: 'A MENON' }],
  ])('rejects a payload carrying %s', (_label, payload) => {
    expect(() => assertNoCardData(payload)).toThrow(CardDataRejectedError);
  });

  it('rejects a card number hidden in a nested field with an innocent name', () => {
    // Luhn-valid Visa test number smuggled through a non-obvious key.
    expect(() => assertNoCardData({ notes: { reference: '4111 1111 1111 1111' } })).toThrow(
      CardDataRejectedError,
    );
  });

  it('rejects card numbers inside arrays', () => {
    expect(() => assertNoCardData({ items: [{ memo: '5500005555555559' }] })).toThrow(
      CardDataRejectedError,
    );
  });

  it('does NOT false-positive on long non-card digit strings', () => {
    // A GSTIN, a phone number and a PNR must all pass.
    expect(() =>
      assertNoCardData({ gstin: '29AABCC1234D1Z5', phone: '+919812345678', pnr: 'QKF7MP' }),
    ).not.toThrow();
  });

  it('does not false-positive on a Luhn-invalid 16-digit string', () => {
    expect(() => assertNoCardData({ ticket: '1234567812345678' })).not.toThrow();
  });

  it('reports the offending field path without echoing the value', () => {
    try {
      assertNoCardData({ payment: { cvv: '123' } });
      expect.unreachable();
    } catch (err) {
      const e = err as CardDataRejectedError;
      expect(e.constraintRef).toBe('CON-13');
      expect(e.detail?.['offendingFields']).toEqual(['$.payment.cvv']);
      // The value itself must never appear in the error.
      expect(JSON.stringify(e.detail)).not.toContain('123');
    }
  });

  it('accepts only provider-issued tokens', () => {
    expect(() => assertPaymentToken(issueMockToken())).not.toThrow();
    expect(() => assertPaymentToken('4111111111111111')).toThrow(CardDataRejectedError);
    expect(() => assertPaymentToken('')).toThrow(CardDataRejectedError);
    expect(() => assertPaymentToken(undefined)).toThrow(CardDataRejectedError);
    expect(() => assertPaymentToken('tok_short')).toThrow(CardDataRejectedError);
  });
});
