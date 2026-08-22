import type {
  Booking,
  FareOffer,
  GstSubmission,
  LegalEntity,
  PassengerDetails,
  Session,
} from '../domain/types.js';
import type { SupplyProvider } from '../supply/port.js';
import { ProviderError } from '../supply/port.js';
import { assertNoMixedFareTypes } from './cart.js';
import { consumeHold, requireLiveHold } from './hold.js';
import { assertBookable, buildGstSubmission, checkPlaceOfSupply } from '../gst/gate.js';
import { assertPaymentToken } from './payment.js';
import { PriceChangedError, DomainError } from '../domain/errors.js';
import { bookingReference, correlationId, id } from '../domain/ids.js';
import { store } from '../store/store.js';
import { priceOffer } from '../search/pricing.js';

export interface BookParams {
  holdId: string;
  session: Session;
  entity: LegalEntity;
  passengers: PassengerDetails[];
  paymentToken: string;
  /** Required on retry after a price change (FR-BOOK-5). */
  acceptedTotal?: number;
  /** Supplied by the client so a retry is the same logical booking (NFR-5). */
  idempotencyKey: string;
}

export class BookingService {
  constructor(private readonly provider: SupplyProvider) {}

  /**
   * Books a held fare.
   *
   * Order matters and is deliberate:
   *   1. idempotency   — a retry must never reach ticketing twice (NFR-5)
   *   2. hold liveness — CON-12
   *   3. CON-1         — before any provider call
   *   4. GST gate      — FR-GST-1, before any provider call
   *   5. payment token — CON-13
   *   6. re-price      — FR-BOOK-5, the last thing before committing money
   */
  async book(params: BookParams): Promise<{ booking: Booking; replayed: boolean }> {
    const cid = correlationId();

    // 1. NFR-5 — return the original booking rather than issuing a second ticket.
    const existing = store.getBookingByIdempotencyKey(params.idempotencyKey);
    if (existing) return { booking: existing, replayed: true };

    // 2. CON-12
    const hold = requireLiveHold(params.holdId);
    const offer = hold.offer;

    // 3. CON-1 — enforced at the cart boundary before we touch the provider.
    assertNoMixedFareTypes([offer]);

    // 4. FR-GST-1 / FR-GST-2 — pre-filled from config; never caller-supplied.
    const gst: GstSubmission = buildGstSubmission(params.entity);
    assertBookable(gst);

    // 5. CON-13
    assertPaymentToken(params.paymentToken);

    // 6. FR-BOOK-5 — re-price immediately before committing.
    const priced = await this.provider.price(offer.id, gst);
    let finalOffer: FareOffer = offer;

    if (priced.changed) {
      const org = store.getOrganisation();
      const repriced = priceOffer(
        {
          providerOfferId: offer.id,
          carrier: offer.carrier,
          fareType: offer.fareType,
          fareBrand: offer.fareBrand,
          cabin: offer.cabin,
          segments: offer.segments,
          baseFare: priced.price.baseFare,
          taxesAndFees: priced.price.taxesAndFees,
          changeFee: offer.landedCost.changeFee,
          cancelFee: offer.landedCost.cancelFee,
          inclusions: offer.inclusions,
        },
        org.gstRates,
        offer.cabin,
      );

      const newTotal = repriced.price.total;
      // The traveller must explicitly accept the new price. Booking silently at
      // a higher price is how a corporate tool loses trust.
      if (params.acceptedTotal !== newTotal) {
        hold.offer = { ...offer, price: repriced.price, landedCost: repriced.landedCost };
        store.putHold(hold);
        throw new PriceChangedError(offer.price.total, newTotal);
      }
      finalOffer = { ...offer, price: repriced.price, landedCost: repriced.landedCost };
    }

    const placeOfSupply = checkPlaceOfSupply(params.entity, finalOffer.segments);
    const config = store
      .getOrganisation()
      .corporateFareConfigs.find((c) => c.carrier === finalOffer.carrier);

    let providerBooking;
    try {
      providerBooking = await this.provider.book({
        providerOfferId: finalOffer.id,
        passengers: params.passengers,
        gst, // CON-5 — present in the book call as well as the price call
        paymentToken: params.paymentToken,
        // CON-3 — ticket-time documentation, distinct from the search-time code
        ...(finalOffer.fareType === 'CORPORATE' && config?.tourCode
          ? { tourCode: config.tourCode }
          : {}),
        // FR-BOOK-4 — corporate traveller SSR unlocks bag/meal/seat
        corporateTravellerSsr: finalOffer.fareType === 'CORPORATE',
        idempotencyKey: params.idempotencyKey,
        correlationId: cid,
      });
    } catch (err) {
      /**
       * FR-BOOK-7 — the dangerous case.
       *
       * A failure here may mean the ticket was never issued, OR that it was
       * issued and the response was lost. We must not assume the former. The
       * caller retries with the same idempotency key; the provider then returns
       * the original booking rather than ticketing again.
       */
      if (err instanceof ProviderError) {
        throw new DomainError(
          `Booking did not complete cleanly and may or may not have ticketed. ` +
            `Retry with the same idempotency key — this will return the existing ticket if one was issued, ` +
            `and will never issue a second.`,
          'BOOKING_INDETERMINATE',
          'FR-BOOK-7',
          502,
          { idempotencyKey: params.idempotencyKey, correlationId: cid, providerMessage: err.message },
        );
      }
      throw err;
    }

    const now = new Date().toISOString();
    const booking: Booking = {
      id: id('bkg'),
      reference: bookingReference(),
      sessionId: params.session.id,
      ownerRef: null, // DEC-7 — populated when auth lands
      pnr: providerBooking.pnr,
      ticketNumbers: providerBooking.ticketNumbers,
      supplyProvider: this.provider.name,
      credentialRef: finalOffer.corporateProof?.credentialRef ?? `secret://supply/${finalOffer.carrier.toLowerCase()}/retail`,
      offer: finalOffer,
      passengers: params.passengers,
      gst,
      paymentToken: params.paymentToken, // token only (CON-13)
      corporateFareApplied: finalOffer.fareType === 'CORPORATE',
      status: 'TICKETED',
      createdAt: now,
      audit: [
        {
          at: now,
          actor: params.session.id, // NFR-3 — session id in v1 (CON-10)
          action: 'BOOKING_TICKETED',
          correlationId: cid,
          detail: {
            idempotencyKey: params.idempotencyKey,
            fareType: finalOffer.fareType,
            carrier: finalOffer.carrier,
            pnr: providerBooking.pnr,
            replayedFromProvider: providerBooking.replayed,
            corporateProof: finalOffer.corporateProof ?? null,
            placeOfSupplyMismatch: placeOfSupply.mismatch,
            totalPayable: finalOffer.landedCost.totalPayable,
            recoverableItc: finalOffer.landedCost.recoverableItc,
          },
        },
      ],
    };

    store.putBooking(booking);
    consumeHold(hold);

    return { booking, replayed: providerBooking.replayed };
  }
}
