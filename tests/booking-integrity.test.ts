import { beforeEach, describe, expect, it } from 'vitest';
import { BookingService } from '../src/booking/bookingService.js';
import { createHold } from '../src/booking/hold.js';
import { assertNoCardData, issueMockToken } from '../src/booking/payment.js';
import { DomainError, PriceChangedError } from '../src/domain/errors.js';
import { mockControl } from '../src/supply/mock/control.js';
import { store } from '../src/store/store.js';
import { criteria, entityFor, makeSession, newOrchestrator, PASSENGER, resetWorld, ALLOCATION, pickBookable} from './helpers.js';

/**
 * FR-BOOK-5 / FR-BOOK-7 / NFR-5 — booking integrity.
 *
 * These are the requirements that decide whether the tool is trusted with real
 * money. A double-issued ticket or a silently repriced fare costs the client
 * directly and is not recoverable by an apology.
 */
async function setup() {
  const { provider, orchestrator } = newOrchestrator();
  const session = makeSession();
  const entity = entityFor(session);
  const result = await orchestrator.search(criteria());
  const offer = pickBookable(result, { fareType: 'CORPORATE' });
  const hold = createHold(offer, session.id);
  return { provider, session, entity, offer, hold, service: new BookingService(provider) };
}

describe('FR-BOOK-5 — a price change halts the booking', () => {
  beforeEach(resetWorld);

  it('refuses to book silently when the price moved', async () => {
    const { service, session, entity, hold } = await setup();
    mockControl.setPriceDelta(0.08); // fare rises 8% between hold and book

    await expect(
      service.book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_price_1',
      }),
    ).rejects.toThrow(PriceChangedError);
  });

  it('reports both the old and the new total so the traveller can decide', async () => {
    const { service, session, entity, hold, offer } = await setup();
    mockControl.setPriceDelta(0.08);

    try {
      await service.book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_price_2',
      });
      expect.unreachable();
    } catch (err) {
      const e = err as PriceChangedError;
      expect(e.constraintRef).toBe('FR-BOOK-5');
      expect(e.detail?.['oldTotal']).toBe(offer.price.total);
      expect(e.detail?.['newTotal']).toBeGreaterThan(offer.price.total);
    }
  });

  it('books once the new price is explicitly accepted', async () => {
    const { service, session, entity, hold } = await setup();
    mockControl.setPriceDelta(0.08);

    let newTotal = 0;
    try {
      await service.book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_price_3',
      });
    } catch (err) {
      newTotal = (err as PriceChangedError).detail?.['newTotal'] as number;
    }
    expect(newTotal).toBeGreaterThan(0);

    const { booking } = await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      acceptedTotal: newTotal,
      idempotencyKey: 'idem_price_3b',
    });

    expect(booking.status).toBe('TICKETED');
    expect(booking.offer.price.total).toBe(newTotal);
  });

  it('does not book at the OLD price when a stale acceptedTotal is replayed', async () => {
    const { service, session, entity, hold, offer } = await setup();
    mockControl.setPriceDelta(0.08);

    await expect(
      service.book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        acceptedTotal: offer.price.total, // the old price
        idempotencyKey: 'idem_price_4',
      }),
    ).rejects.toThrow(PriceChangedError);
  });
});

describe('FR-BOOK-7 / NFR-5 — a retry never double-tickets', () => {
  beforeEach(resetWorld);

  it('returns the original booking when the same idempotency key is replayed', async () => {
    const { service, session, entity, hold } = await setup();
    const key = 'idem_replay_1';

    const first = await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: key,
    });
    const second = await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: key,
    });

    expect(second.replayed).toBe(true);
    expect(second.booking.id).toBe(first.booking.id);
    expect(second.booking.pnr).toBe(first.booking.pnr);
    expect(store.listBookings()).toHaveLength(1);
  });

  it('CHAOS — a lost response then 5 retries produces exactly one ticket', async () => {
    // spec.md Stage 2 exit criterion: "kill mid-book, retry x5 -> exactly one ticket".
    const { service, session, entity, hold } = await setup();
    const key = 'idem_chaos_1';

    // The provider issues the ticket, then the response is lost in transit.
    mockControl.armDroppedBookResponse();

    await expect(
      service.book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: key,
      }),
    ).rejects.toThrow(DomainError);

    // The caller does not know whether it ticketed. It retries with the same key.
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await service.book({
          holdId: hold.id,
          session,
          entity,
          passengers: [PASSENGER],
          paymentToken: issueMockToken(),
          allocation: ALLOCATION,
          idempotencyKey: key,
        }),
      );
    }

    const pnrs = new Set(results.map((r) => r.booking.pnr));
    expect(pnrs.size, 'every retry must resolve to the same PNR').toBe(1);
    expect(store.listBookings(), 'exactly one booking record').toHaveLength(1);

    const tickets = new Set(store.listBookings()[0]!.ticketNumbers);
    expect(tickets.size).toBe(1);
  });

  it('surfaces an indeterminate booking rather than claiming failure', async () => {
    const { service, session, entity, hold } = await setup();
    mockControl.armDroppedBookResponse();

    try {
      await service.book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_indeterminate',
      });
      expect.unreachable();
    } catch (err) {
      const e = err as DomainError;
      expect(e.code).toBe('BOOKING_INDETERMINATE');
      expect(e.constraintRef).toBe('FR-BOOK-7');
      // It must NOT tell the caller the booking failed — it may have ticketed.
      expect(e.message).toContain('may or may not have ticketed');
    }
  });

  it('different idempotency keys DO create separate bookings', async () => {
    const { service, session, entity, hold, provider } = await setup();
    await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'idem_a',
    });

    // A second hold, since the first is consumed.
    const { orchestrator } = newOrchestrator(provider);
    const result = await orchestrator.search(criteria({ destination: 'BLR' }));
    const hold2 = createHold(pickBookable(result, { fareType: 'CORPORATE' }), session.id);

    await service.book({
      holdId: hold2.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'idem_b',
    });

    expect(store.listBookings()).toHaveLength(2);
  });

  it('a consumed hold cannot be booked again with a fresh key', async () => {
    const { service, session, entity, hold } = await setup();
    await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'idem_consume_1',
    });

    await expect(
      service.book({
        holdId: hold.id,
        session,
        entity,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        allocation: ALLOCATION,
        idempotencyKey: 'idem_consume_2',
      }),
    ).rejects.toThrow(/hold/i);
  });
});

describe('NFR-3 / NFR-4 — audit trail', () => {
  beforeEach(resetWorld);

  it('records actor, correlation id and the corporate proof on ticketing', async () => {
    const { service, session, entity, hold } = await setup();
    const { booking } = await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'idem_audit',
    });

    expect(booking.audit).toHaveLength(1);
    const entry = booking.audit[0]!;
    expect(entry.action).toBe('BOOKING_TICKETED');
    // CON-10: the actor is the session id in v1, populated from day one so
    // records stay comparable once auth lands (DEC-7).
    expect(entry.actor).toBe(session.id);
    expect(entry.correlationId).toMatch(/^cor_/);
    expect(entry.detail?.['corporateProof']).toBeTruthy();
    expect(entry.detail?.['recoverableItc']).toBeGreaterThan(0);
  });

  it('never stores card data on the booking — only a token (CON-13)', async () => {
    const { service, session, entity, hold } = await setup();
    const { booking } = await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      allocation: ALLOCATION,
      idempotencyKey: 'idem_token',
    });

    expect(booking.paymentToken).toMatch(/^tok_/);
    // Assert through the production guard rather than a hand-rolled regex: a
    // naive digit-run pattern flags ticket numbers and phone numbers, which is
    // exactly the false positive the Luhn check in the guard exists to avoid.
    expect(() => assertNoCardData(booking)).not.toThrow();
  });
});
