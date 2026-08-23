import type { Booking } from '../domain/types.js';
import type { SupplyProvider } from '../supply/port.js';
import { DomainError, NameChangeUnsupportedError, NotFoundError } from '../domain/errors.js';
import { correlationId, id } from '../domain/ids.js';
import { store } from '../store/store.js';
import { FREE_CHANGE_WINDOW_HOURS } from '../supply/mock/fixtures.js';

/**
 * Post-booking servicing — Stage 2, FR-SVC-1 / FR-SVC-2 / FR-SVC-4.
 *
 * Consulting travel changes constantly, so this is high-volume, not an edge
 * case. The rule throughout: show the ACTUAL fee before anything is committed.
 * Corporate fares reduce change and cancellation fees, they do not waive them
 * (CON-8), and the fees differ materially by carrier.
 */

export interface CancellationQuote {
  bookingId: string;
  reference: string;
  cancellationFee: number;
  refundAmount: number;
  /** ITC on a cancelled ticket is reversed with the refund. */
  itcReversed: number;
  fareType: string;
  carrier: string;
  notes: string[];
  withinFreeWindow: boolean;
}

function hoursUntilDeparture(booking: Booking, now = Date.now()): number {
  const first = booking.offer.segments[0];
  if (!first) return 0;
  return (new Date(first.departsAt).getTime() - now) / 3_600_000;
}

export class ServicingService {
  constructor(private readonly provider: SupplyProvider) {}

  /** FR-SVC-2 — the quote a traveller sees BEFORE committing to cancel. */
  async quoteCancellation(bookingId: string): Promise<CancellationQuote> {
    const booking = this.require(bookingId);
    const rules = await this.provider.fareRules(booking.offer.id);

    const hoursOut = hoursUntilDeparture(booking);
    const freeWindow = FREE_CHANGE_WINDOW_HOURS[booking.offer.carrier];
    const withinFreeWindow =
      booking.offer.fareType === 'CORPORATE' && freeWindow !== undefined && hoursOut > freeWindow;

    const fee = booking.offer.landedCost.cancelFee;
    const paid = booking.offer.landedCost.totalPayable;

    return {
      bookingId: booking.id,
      reference: booking.reference,
      cancellationFee: fee,
      refundAmount: Math.max(0, paid - fee),
      itcReversed: booking.offer.landedCost.recoverableItc,
      fareType: booking.offer.fareType,
      carrier: booking.offer.carrier,
      notes: rules.notes,
      withinFreeWindow,
    };
  }

  async cancel(bookingId: string, actor: string): Promise<Booking> {
    const booking = this.require(bookingId);
    if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
      throw new DomainError(
        `Booking ${booking.reference} is already cancelled.`,
        'ALREADY_CANCELLED',
        'FR-SVC-1',
        409,
      );
    }

    const cid = correlationId();
    const result = await this.provider.cancel(booking.pnr, cid);

    booking.status = 'CANCELLED';
    booking.cancelledAt = new Date().toISOString();
    booking.cancellationFee = result.cancellationFee;
    booking.refundAmount = result.refundAmount;

    /**
     * FR-SVC-3 — Indian carriers typically return value as a credit shell held
     * with the airline rather than cash. Untracked, that value silently expires
     * and the company pays twice. Validity is one year from issue.
     */
    if (result.refundAmount > 0) {
      const issuedAt = booking.cancelledAt;
      booking.creditShell = {
        amount: result.refundAmount,
        carrier: booking.offer.carrier,
        issuedAt,
        expiresAt: new Date(new Date(issuedAt).getTime() + 365 * 86_400_000).toISOString(),
        consumed: false,
      };
    }
    booking.audit.push({
      at: booking.cancelledAt,
      actor,
      action: 'BOOKING_CANCELLED',
      correlationId: cid,
      detail: {
        cancellationFee: result.cancellationFee,
        refundAmount: result.refundAmount,
        // The ITC is reversed along with the fare — finance must not keep claiming it.
        itcReversed: booking.offer.landedCost.recoverableItc,
        creditShellAmount: booking.creditShell?.amount ?? 0,
        creditShellExpiresAt: booking.creditShell?.expiresAt ?? null,
      },
    });
    store.putBooking(booking);
    return booking;
  }

  /**
   * Change quote (FR-SVC-2).
   *
   * v1 deliberately stops at the quote. A real change is a re-search plus a
   * fare-difference calculation against live inventory; doing it properly needs
   * the ranking and comparison work in Stage 3. Quoting the fee and routing to
   * the desk is honest — silently doing half a change is not.
   */
  async quoteChange(bookingId: string): Promise<{
    changeFee: number;
    withinFreeWindow: boolean;
    notes: string[];
    handoff: string;
  }> {
    const booking = this.require(bookingId);
    const rules = await this.provider.fareRules(booking.offer.id);
    const hoursOut = hoursUntilDeparture(booking);
    const freeWindow = FREE_CHANGE_WINDOW_HOURS[booking.offer.carrier];
    const withinFreeWindow =
      booking.offer.fareType === 'CORPORATE' && freeWindow !== undefined && hoursOut > freeWindow;

    return {
      changeFee: withinFreeWindow ? 0 : booking.offer.landedCost.changeFee,
      withinFreeWindow,
      notes: [
        ...rules.notes,
        'A fare difference applies in addition to the change fee and is quoted at rebooking.',
      ],
      handoff:
        'In-tool rebooking arrives in a later stage. Submit this quote to the travel desk to complete the change.',
    };
  }

  /**
   * FR-SVC-4 — name change is not supported at launch.
   *
   * Not an oversight: carrier name-change rules were not established for ANY
   * Indian carrier during research (research.md §4.3), and trip reassignment is
   * common in consulting. Guessing the rules would produce wrong fees on real
   * money, so this routes to a human until the rules are confirmed.
   */
  requestNameChange(bookingId: string): never {
    this.require(bookingId);
    throw new NameChangeUnsupportedError();
  }

  private require(bookingId: string): Booking {
    const booking = store.getBooking(bookingId);
    if (!booking) throw new NotFoundError('Booking', bookingId);
    return booking;
  }
}

export function raiseServicingAlert(message: string, detail: Record<string, unknown>): void {
  store.raiseAlert({
    id: id('alr'),
    at: new Date().toISOString(),
    severity: 'ERROR',
    code: 'SERVICING_FAILURE',
    message,
    detail,
    acknowledged: false,
  });
}
