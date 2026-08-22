import { beforeEach, describe, expect, it } from 'vitest';
import { BookingService } from '../src/booking/bookingService.js';
import { ServicingService } from '../src/booking/servicing.js';
import { createHold } from '../src/booking/hold.js';
import { issueMockToken } from '../src/booking/payment.js';
import { NameChangeUnsupportedError, NotFoundError } from '../src/domain/errors.js';
import { store } from '../src/store/store.js';
import { rupees } from '../src/domain/money.js';
import { criteria, entityFor, makeSession, newOrchestrator, PASSENGER, resetWorld } from './helpers.js';
import type { CarrierCode, FareType } from '../src/domain/types.js';

/**
 * Stage 2 servicing — FR-SVC-1 / FR-SVC-2 / FR-SVC-4.
 *
 * Consulting travel changes constantly, so this is the high-volume path, not an
 * edge case. The rule: show the ACTUAL fee before anything is committed.
 */
async function book(carrier: CarrierCode, fareType: FareType = 'CORPORATE') {
  const { provider, orchestrator } = newOrchestrator();
  const session = makeSession();
  const entity = entityFor(session);
  const result = await orchestrator.search(criteria());
  const offer = result.offers.find((o) => o.carrier === carrier && o.fareType === fareType)!;
  const hold = createHold(offer, session.id);
  const { booking } = await new BookingService(provider).book({
    holdId: hold.id,
    session,
    entity,
    passengers: [PASSENGER],
    paymentToken: issueMockToken(),
    idempotencyKey: `idem_${carrier}_${fareType}_${Math.random()}`,
  });
  return { booking, session, servicing: new ServicingService(provider) };
}

describe('FR-SVC-2 — the real fee is quoted before committing', () => {
  beforeEach(resetWorld);

  it('quotes the corporate cancellation fee, not the retail one', async () => {
    const { booking, servicing } = await book('6E', 'CORPORATE');
    const quote = await servicing.quoteCancellation(booking.id);
    // research.md §4: IndiGo corporate cancel ~₹999-1,499, vs ~₹2,999 retail.
    expect(quote.cancellationFee).toBe(rupees(1199));
    expect(quote.fareType).toBe('CORPORATE');
  });

  it('quotes the higher retail fee on a retail booking', async () => {
    const { booking, servicing } = await book('6E', 'RETAIL');
    const quote = await servicing.quoteCancellation(booking.id);
    expect(quote.cancellationFee).toBe(rupees(2999));
  });

  it('reflects that corporate fares REDUCE fees rather than waiving them (CON-8)', async () => {
    const { booking, servicing } = await book('AI', 'CORPORATE');
    const quote = await servicing.quoteCancellation(booking.id);
    expect(quote.cancellationFee).toBeGreaterThan(0);
    expect(quote.notes.join(' ')).toContain('do not waive them');
  });

  it('recognises Akasa as the fee-free-window outlier (research.md §4.3)', async () => {
    const { booking, servicing } = await book('QP', 'CORPORATE');
    const quote = await servicing.quoteCancellation(booking.id);
    expect(quote.cancellationFee).toBe(rupees(250));
    expect(quote.withinFreeWindow).toBe(true);
    expect(quote.notes.join(' ')).toMatch(/No change or cancellation fee/);
  });

  it('shows the refund and flags that ITC is reversed with it', async () => {
    const { booking, servicing } = await book('6E', 'CORPORATE');
    const quote = await servicing.quoteCancellation(booking.id);
    expect(quote.refundAmount).toBe(booking.offer.landedCost.totalPayable - quote.cancellationFee);
    // Finance must stop claiming the credit on a cancelled ticket.
    expect(quote.itcReversed).toBe(booking.offer.landedCost.recoverableItc);
  });

  it('quotes a change fee and is explicit that a fare difference also applies', async () => {
    const { booking, servicing } = await book('6E', 'CORPORATE');
    const quote = await servicing.quoteChange(booking.id);
    expect(quote.changeFee).toBe(rupees(499));
    expect(quote.notes.join(' ')).toContain('fare difference');
    expect(quote.handoff).toContain('travel desk');
  });
});

describe('FR-SVC-1 — cancellation', () => {
  beforeEach(resetWorld);

  it('cancels, records the fee and refund, and writes an audit entry', async () => {
    const { booking, session, servicing } = await book('6E', 'CORPORATE');
    const cancelled = await servicing.cancel(booking.id, session.id);

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationFee).toBe(rupees(1199));
    expect(cancelled.refundAmount).toBeGreaterThan(0);

    const entry = cancelled.audit.find((a) => a.action === 'BOOKING_CANCELLED');
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe(session.id);
    expect(entry?.detail?.['itcReversed']).toBe(booking.offer.landedCost.recoverableItc);
  });

  it('refuses to cancel twice', async () => {
    const { booking, session, servicing } = await book('6E', 'CORPORATE');
    await servicing.cancel(booking.id, session.id);
    await expect(servicing.cancel(booking.id, session.id)).rejects.toThrow(/already cancelled/i);
  });

  it('persists the cancellation', async () => {
    const { booking, session, servicing } = await book('6E', 'CORPORATE');
    await servicing.cancel(booking.id, session.id);
    expect(store.getBooking(booking.id)?.status).toBe('CANCELLED');
  });
});

describe('FR-SVC-4 — name change is routed to a human, never guessed', () => {
  beforeEach(resetWorld);

  it('refuses with 501 and explains why', async () => {
    const { booking, servicing } = await book('6E', 'CORPORATE');
    try {
      servicing.requestNameChange(booking.id);
      expect.unreachable();
    } catch (err) {
      const e = err as NameChangeUnsupportedError;
      expect(e.constraintRef).toBe('FR-SVC-4');
      expect(e.status).toBe(501);
      // Grounded: carrier name-change rules were never established (research.md §4.3).
      expect(e.message).toContain('travel desk');
    }
  });
});

describe('Stage 2 — retrieval by reference closes the CON-10 hole', () => {
  beforeEach(resetWorld);

  it('finds a booking by its reference after the session is gone', async () => {
    const { booking } = await book('6E', 'CORPORATE');
    // Simulate the browser being closed: the session no longer resolves.
    const found = store.getBookingByReference(booking.reference);
    expect(found?.id).toBe(booking.id);
  });

  it('is case-insensitive, because references get read aloud and retyped', async () => {
    const { booking } = await book('6E', 'CORPORATE');
    expect(store.getBookingByReference(booking.reference.toLowerCase())?.id).toBe(booking.id);
    expect(store.getBookingByReference(` ${booking.reference} `)?.id).toBe(booking.id);
  });

  it('uses an alphabet free of ambiguous characters', async () => {
    const { booking } = await book('6E', 'CORPORATE');
    expect(booking.reference).toMatch(/^CFB-[ACDEFGHJKLMNPQRTUVWXY3456789]{6}$/);
    // No 0/O, 1/I, 2/Z, S/5, B/8 confusion.
    expect(booking.reference.slice(4)).not.toMatch(/[01IOSBZ2]/);
  });

  it('returns nothing for an unknown reference', () => {
    expect(store.getBookingByReference('CFB-XXXXXX')).toBeUndefined();
  });

  it('throws NotFoundError when servicing an unknown booking', async () => {
    const { servicing } = await book('6E', 'CORPORATE');
    await expect(servicing.quoteCancellation('bkg_nope')).rejects.toThrow(NotFoundError);
  });
});
