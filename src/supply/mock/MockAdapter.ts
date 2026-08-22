import { createHash } from 'node:crypto';
import type {
  CancelResult,
  FareRules,
  PricedOffer,
  ProviderBookRequest,
  ProviderBooking,
  ProviderOffer,
  ProviderSearchRequest,
  SupplyProvider,
} from '../port.js';
import { ProviderError } from '../port.js';
import type { CarrierCode, FareType, GstSubmission, Segment } from '../../domain/types.js';
import { pnr as makePnr, ticketNumber } from '../../domain/ids.js';
import {
  CARRIER_RATE,
  CORPORATE_DISCOUNT_BAND,
  FARE_BRANDS,
  FEE_TABLE,
  FREE_CHANGE_WINDOW_HOURS,
  INCLUSIONS,
  SCHEDULE,
  distanceKm,
} from './fixtures.js';
import { mockControl } from './control.js';

/** Deterministic 0..1 from a string, so the same query always prices the same. */
function hashUnit(input: string): number {
  const h = createHash('sha256').update(input).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * Mock supply provider — CON-6 / DEC-1.
 *
 * Models the one thing that actually shapes our architecture: corporate and
 * retail content live behind DIFFERENT credentials and are returned by
 * DIFFERENT queries (CON-1, CON-2). A credential provisioned for retail cannot
 * see corporate fares, and vice versa — which is why `search` rejects a
 * mismatched credential rather than quietly returning the wrong content.
 */
export class MockAdapter implements SupplyProvider {
  readonly name = 'mock';

  /** providerOfferId -> offer, so price() and book() can resolve it. */
  private readonly offers = new Map<string, ProviderOffer>();
  /** idempotencyKey -> booking (NFR-5, FR-BOOK-7). */
  private readonly bookings = new Map<string, ProviderBooking>();
  /** pnr -> offer, for cancellation fee lookup. */
  private readonly bookedOffers = new Map<string, ProviderOffer>();

  async search(req: ProviderSearchRequest): Promise<ProviderOffer[]> {
    const { carrier, fareScope, credential, criteria, signal } = req;

    // CON-1: a credential provisioned for one fare scope cannot retrieve the
    // other. Real-world equivalent: Travelport warning 701422 on IndiGo.
    if (credential.fareScope !== fareScope) {
      throw new ProviderError(
        `Credential ${credential.ref} is provisioned for ${credential.fareScope} content ` +
          `but a ${fareScope} search was attempted. Separate Agency IDs/PCCs are required.`,
        'MISCONFIGURED',
      );
    }

    // FR-SRCH-6: corporate searches must carry a retrieval key unless the
    // mechanism is credential-based (CON-3 — the code unlocks, the tour code does not).
    if (fareScope === 'CORPORATE' && req.mechanism !== 'CREDENTIAL' && !req.code) {
      throw new ProviderError(
        `Corporate search for ${carrier} requires a retrieval code for mechanism ${req.mechanism}.`,
        'MISCONFIGURED',
      );
    }

    const injected = mockControl.matchLeg(carrier, fareScope);
    if (injected === 'TIMEOUT') {
      // Longer than any sane budget; the orchestrator's 5s deadline (CON-11)
      // is what actually cuts this off.
      await sleep(30_000, signal);
    } else if (injected === 'AUTH_FAILURE') {
      throw new ProviderError(`Credential ${credential.ref} rejected by carrier ${carrier}.`, 'AUTH_FAILURE');
    } else if (injected === 'MISCONFIGURED') {
      throw new ProviderError(`No corporate configuration active for ${carrier}.`, 'MISCONFIGURED');
    } else if (injected === 'PROVIDER_ERROR') {
      throw new ProviderError(`Upstream provider error for ${carrier}.`, 'PROVIDER_ERROR');
    } else if (injected === 'NO_INVENTORY') {
      return [];
    }

    if (mockControl.latency > 0) await sleep(mockControl.latency, signal);
    else await sleep(40 + Math.floor(hashUnit(carrier + fareScope) * 120), signal);

    return this.buildOffers(req);
  }

  private buildOffers(req: ProviderSearchRequest): ProviderOffer[] {
    const { carrier, fareScope, criteria, credential } = req;
    const { origin, destination, departDate, cabin } = criteria;
    const km = distanceKm(origin, destination);
    const durationMinutes = Math.round(60 + (km / 750) * 60);

    const daysOut = Math.max(
      0,
      Math.round((new Date(departDate).getTime() - Date.now()) / 86_400_000),
    );
    // Near-term departures price higher — consulting travel is often last-minute.
    const urgency = daysOut <= 2 ? 1.45 : daysOut <= 7 ? 1.2 : daysOut <= 21 ? 1.0 : 0.92;

    const slots = SCHEDULE[carrier] ?? [];
    const offers: ProviderOffer[] = [];

    for (const slot of slots) {
      const seed = `${carrier}|${slot.num}|${origin}|${destination}|${departDate}`;
      const variance = 0.85 + hashUnit(seed) * 0.4;

      const departsAt = new Date(`${departDate}T${slot.dep}:00.000+05:30`).toISOString();
      const arrivesAt = addMinutes(departsAt, durationMinutes);

      const segment: Segment = {
        carrier,
        flightNumber: slot.num,
        origin,
        destination,
        departsAt,
        arrivesAt,
        durationMinutes,
      };

      const rate = CARRIER_RATE[carrier];
      let baseFare = Math.round(km * rate * urgency * variance);
      if (cabin === 'PREMIUM') baseFare = Math.round(baseFare * 2.6);

      if (fareScope === 'CORPORATE') {
        // 5-10% off base — the only credible researched band (research.md §6.2).
        const spread = CORPORATE_DISCOUNT_BAND.max - CORPORATE_DISCOUNT_BAND.min;
        const discount = CORPORATE_DISCOUNT_BAND.min + hashUnit(seed + '|corp') * spread;
        baseFare = Math.round(baseFare * (1 - discount));
      }

      // Carrier-imposed taxes/fees, excluding GST (GST is computed by our pricing layer).
      const taxesAndFees = Math.round(baseFare * 0.09) + 23_600;

      const fees = FEE_TABLE[carrier][fareScope];
      const providerOfferId = `${this.name}:${carrier}:${fareScope}:${slot.num}:${departDate}:${cabin}`;

      const offer: ProviderOffer = {
        providerOfferId,
        carrier,
        fareType: fareScope,
        fareBrand: FARE_BRANDS[carrier][fareScope],
        cabin,
        segments: [segment],
        baseFare,
        taxesAndFees,
        changeFee: fees.change,
        cancelFee: fees.cancel,
        inclusions: INCLUSIONS[carrier][fareScope],
        ...(fareScope === 'CORPORATE'
          ? {
              // FR-SRCH-5: proof the corporate fare was actually applied.
              privateFare: true,
              negotiatedFare: req.mechanism === 'ACCOUNT_CODE' || req.mechanism === 'CONTRACT_CODE',
              pseudoCityCode: credential.ref.slice(-4).toUpperCase(),
            }
          : {}),
      };

      this.offers.set(providerOfferId, offer);
      offers.push(offer);
    }

    return offers;
  }

  async price(providerOfferId: string, gst: GstSubmission): Promise<PricedOffer> {
    const offer = this.offers.get(providerOfferId);
    if (!offer) throw new ProviderError(`Unknown offer ${providerOfferId}`, 'PROVIDER_ERROR');

    // CON-5: GST details must be present in the PRICE call as well as the book
    // call. Missing them here is how input tax credit is silently lost.
    assertGstPresent(gst, 'price');

    const delta = mockControl.takePriceDelta();
    if (delta !== null) {
      const updated: ProviderOffer = {
        ...offer,
        baseFare: Math.round(offer.baseFare * (1 + delta)),
      };
      updated.taxesAndFees = Math.round(updated.baseFare * 0.09) + 23_600;
      this.offers.set(providerOfferId, updated);
      return {
        providerOfferId,
        price: { baseFare: updated.baseFare, taxesAndFees: updated.taxesAndFees },
        changed: true,
      };
    }

    return {
      providerOfferId,
      price: { baseFare: offer.baseFare, taxesAndFees: offer.taxesAndFees },
      changed: false,
    };
  }

  async book(req: ProviderBookRequest): Promise<ProviderBooking> {
    // NFR-5 / FR-BOOK-7: a retried book call returns the original booking.
    // Checked BEFORE any ticketing work so a retry can never double-ticket.
    const existing = this.bookings.get(req.idempotencyKey);
    if (existing) return { ...existing, replayed: true };

    const offer = this.offers.get(req.providerOfferId);
    if (!offer) throw new ProviderError(`Unknown offer ${req.providerOfferId}`, 'PROVIDER_ERROR');

    // CON-5: and again in the book call.
    assertGstPresent(req.gst, 'book');

    if (!req.paymentToken || !req.paymentToken.startsWith('tok_')) {
      // CON-13: only provider-issued tokens ever reach this layer.
      throw new ProviderError('A provider-issued payment token is required.', 'PROVIDER_ERROR');
    }

    const booking: ProviderBooking = {
      pnr: makePnr(),
      ticketNumbers: req.passengers.map(() => ticketNumber(carrierNumeric(offer.carrier))),
      replayed: false,
    };

    // The ticket is recorded BEFORE we simulate the lost response, exactly as a
    // real carrier would: the ticket exists even though the caller never saw it.
    this.bookings.set(req.idempotencyKey, booking);
    this.bookedOffers.set(booking.pnr, offer);

    if (mockControl.takeDroppedBookResponse()) {
      throw new ProviderError(
        'Network failure after ticketing — response lost. Retry with the same idempotency key.',
        'PROVIDER_ERROR',
      );
    }

    return booking;
  }

  async cancel(pnrValue: string): Promise<CancelResult> {
    const offer = this.bookedOffers.get(pnrValue);
    if (!offer) throw new ProviderError(`Unknown PNR ${pnrValue}`, 'PROVIDER_ERROR');
    const paid = offer.baseFare + offer.taxesAndFees;
    const fee = offer.cancelFee;
    return { cancellationFee: fee, refundAmount: Math.max(0, paid - fee) };
  }

  async fareRules(providerOfferId: string): Promise<FareRules> {
    const offer = this.offers.get(providerOfferId);
    if (!offer) throw new ProviderError(`Unknown offer ${providerOfferId}`, 'PROVIDER_ERROR');
    const notes: string[] = [];
    const freeWindow = FREE_CHANGE_WINDOW_HOURS[offer.carrier];
    if (offer.fareType === 'CORPORATE' && freeWindow) {
      notes.push(
        `No change or cancellation fee up to ${freeWindow} hour(s) before departure. ` +
          `Fare difference and admin fee still apply.`,
      );
    }
    if (offer.fareType === 'CORPORATE') {
      notes.push('Corporate fares reduce change and cancellation fees; they do not waive them.');
    }
    notes.push('Name changes are not permitted in-tool and must be handled by the travel desk.');
    return {
      changeFee: offer.changeFee,
      cancelFee: offer.cancelFee,
      ...(freeWindow ? { freeChangeWindowHours: freeWindow } : {}),
      notes,
    };
  }
}

function assertGstPresent(gst: GstSubmission | undefined, phase: 'price' | 'book'): void {
  if (!gst?.gstin || !gst.legalName) {
    throw new ProviderError(
      `GST details missing from the ${phase} call. They are mandatory in BOTH price and book (CON-5).`,
      'MISCONFIGURED',
    );
  }
}

function carrierNumeric(carrier: CarrierCode): string {
  return { '6E': '312', AI: '098', QP: '441', SG: '775' }[carrier];
}
