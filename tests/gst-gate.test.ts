import { beforeEach, describe, expect, it } from 'vitest';
import { validateGstin } from '../src/domain/gstin.js';
import { assertBookable, buildGstSubmission, checkPlaceOfSupply } from '../src/gst/gate.js';
import { GstRequiredError } from '../src/domain/errors.js';
import { BookingService } from '../src/booking/bookingService.js';
import { createHold } from '../src/booking/hold.js';
import { issueMockToken } from '../src/booking/payment.js';
import { store } from '../src/store/store.js';
import { criteria, entityFor, makeSession, newOrchestrator, PASSENGER, resetWorld } from './helpers.js';

/**
 * FR-GST-1 / FR-GST-2 / CON-4 — the highest-ROI requirement in the product.
 *
 * ITC is worth ~4.8% of all-in economy cost (~₹12 lakh/year at this volume) and
 * CANNOT be corrected after ticketing. Every point of GSTIN-attach leakage is
 * ≈₹12,000/month, so "mostly attached" is not a passing grade.
 */
describe('GSTIN positional validation (CON-5, FR-ORG-1)', () => {
  it('accepts a well-formed GSTIN', () => {
    const v = validateGstin('29AABCC1234D1Z5');
    expect(v.valid).toBe(true);
    expect(v.stateCode).toBe('29');
  });

  it.each([
    ['AA', 'too short'],
    ['29AABCC1234D1Z', '14 characters'],
    ['29AABCC1234D1Z55', '16 characters'],
    ['2AABCCC1234D1Z5', 'characters 1-2 not both numeric'],
    ['291BCC01234D1Z5', 'characters 3-7 not alphabetic'],
    ['29AABCCABCDD1Z5', 'characters 8-11 not numeric'],
    ['29AABCC12341Z55', 'character 12 not alphabetic'],
  ])('rejects %s (%s)', (value) => {
    expect(validateGstin(value).valid).toBe(false);
  });

  it('reports each positional failure separately rather than one opaque message', () => {
    const v = validateGstin('2AABCCABCDD1Z55');
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(1);
  });

  it('rejects empty and null input', () => {
    expect(validateGstin('').valid).toBe(false);
    expect(validateGstin(undefined).valid).toBe(false);
    expect(validateGstin(null).valid).toBe(false);
  });
});

describe('FR-GST-1 — booking is hard-blocked without valid GST details', () => {
  beforeEach(resetWorld);

  it('blocks when the GSTIN is invalid', () => {
    expect(() =>
      assertBookable({
        gstin: 'NOTAGSTIN',
        legalName: 'X',
        stateCode: '29',
        email: 'a@b.com',
        submittedAt: new Date().toISOString(),
      }),
    ).toThrow(GstRequiredError);
  });

  it('blocks when the registered legal name is missing', () => {
    expect(() =>
      assertBookable({
        gstin: '29AABCC1234D1Z5',
        legalName: '   ',
        stateCode: '29',
        email: 'a@b.com',
        submittedAt: new Date().toISOString(),
      }),
    ).toThrow(GstRequiredError);
  });

  it('blocks when no GST details are supplied at all', () => {
    expect(() => assertBookable(undefined)).toThrow(GstRequiredError);
  });

  it('cites FR-GST-1 so the rejection is traceable to the rule', () => {
    try {
      assertBookable(undefined);
      expect.unreachable();
    } catch (err) {
      expect((err as GstRequiredError).constraintRef).toBe('FR-GST-1');
      expect((err as GstRequiredError).status).toBe(422);
    }
  });

  it('makes NO provider booking call when GST is invalid', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const offer = result.offers[0]!;
    const hold = createHold(offer, session.id);

    let bookCalls = 0;
    const spied = new Proxy(provider, {
      get(t, p, r) {
        if (p === 'book') {
          return async (...a: unknown[]) => {
            bookCalls += 1;
            return (t.book as (...x: unknown[]) => unknown).apply(t, a);
          };
        }
        return Reflect.get(t, p, r);
      },
    });

    // Corrupt the configured entity so the gate must reject.
    const org = store.getOrganisation();
    org.legalEntities[0]!.gstin = 'BROKEN';
    store.setOrganisation(org);

    const service = new BookingService(spied);
    await expect(
      service.book({
        holdId: hold.id,
        session,
        entity: store.getLegalEntity(entity.id)!,
        passengers: [PASSENGER],
        paymentToken: issueMockToken(),
        idempotencyKey: 'idem_gst_block',
      }),
    ).rejects.toThrow(GstRequiredError);

    expect(bookCalls, 'no provider call may be made when GST is invalid').toBe(0);
  });
});

describe('FR-GST-2 — GST details are pre-filled from config, never traveller-entered', () => {
  beforeEach(resetWorld);

  it('derives the submission from the configured legal entity', () => {
    const session = makeSession();
    const entity = entityFor(session);
    const gst = buildGstSubmission(entity);
    expect(gst.gstin).toBe(entity.gstin);
    expect(gst.legalName).toBe(entity.registeredName);
    expect(gst.stateCode).toBe(entity.stateCode);
  });

  it('normalises the GSTIN to uppercase', () => {
    const entity = { ...entityFor(makeSession()), gstin: '29aabcc1234d1z5' };
    expect(buildGstSubmission(entity).gstin).toBe('29AABCC1234D1Z5');
  });

  it('persists the GST submission onto the booking (CON-4 evidence)', async () => {
    const { provider, orchestrator } = newOrchestrator();
    const session = makeSession();
    const entity = entityFor(session);
    const result = await orchestrator.search(criteria());
    const hold = createHold(result.offers[0]!, session.id);
    const service = new BookingService(provider);
    const { booking } = await service.book({
      holdId: hold.id,
      session,
      entity,
      passengers: [PASSENGER],
      paymentToken: issueMockToken(),
      idempotencyKey: 'idem_gst_persist',
    });
    expect(booking.gst.gstin).toBe(entity.gstin);
    expect(booking.gst.legalName).toBe(entity.registeredName);
  });
});

describe('place-of-supply mismatch (research.md §5.2)', () => {
  beforeEach(resetWorld);

  it('flags when the billing entity state differs from the departure state', () => {
    const entity = entityFor(makeSession()); // Karnataka, state 29
    const check = checkPlaceOfSupply(entity, [
      {
        carrier: '6E',
        flightNumber: '6E-1',
        origin: 'DEL', // state 07
        destination: 'BOM',
        departsAt: new Date().toISOString(),
        arrivesAt: new Date().toISOString(),
        durationMinutes: 120,
      },
    ]);
    expect(check.mismatch).toBe(true);
    expect(check.message).toContain('cannot be claimed');
  });

  it('does not flag when they match', () => {
    const entity = entityFor(makeSession());
    const check = checkPlaceOfSupply(entity, [
      {
        carrier: '6E',
        flightNumber: '6E-1',
        origin: 'BLR', // state 29, matches the Karnataka entity
        destination: 'DEL',
        departsAt: new Date().toISOString(),
        arrivesAt: new Date().toISOString(),
        durationMinutes: 120,
      },
    ]);
    expect(check.mismatch).toBe(false);
  });
});
