import type { FareHold, FareOffer } from '../domain/types.js';
import { HoldExpiredError, NotFoundError } from '../domain/errors.js';
import { id } from '../domain/ids.js';
import { store } from '../store/store.js';

/** CON-12, FR-BOOK-9 — a selected fare is held for exactly 5 minutes. */
export const HOLD_TTL_MS = 5 * 60 * 1000;

export function createHold(offer: FareOffer, sessionId: string): FareHold {
  const now = new Date();
  const hold: FareHold = {
    id: id('hold'),
    offer,
    sessionId,
    heldAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + HOLD_TTL_MS).toISOString(),
    status: 'HELD',
  };
  store.putHold(hold);
  return hold;
}

export function remainingMs(hold: FareHold, now = Date.now()): number {
  return Math.max(0, new Date(hold.expiresAt).getTime() - now);
}

export function isExpired(hold: FareHold, now = Date.now()): boolean {
  return remainingMs(hold, now) <= 0;
}

/**
 * Resolves a hold for booking.
 *
 * An expired hold is not merely stale — the price behind it may have moved, so
 * booking against it would sell a fare that no longer exists. The caller must
 * re-price and the traveller must confirm any change (FR-BOOK-5).
 */
export function requireLiveHold(holdId: string, now = Date.now()): FareHold {
  const hold = store.getHold(holdId);
  if (!hold) throw new NotFoundError('Fare hold', holdId);

  if (hold.status === 'EXPIRED' || isExpired(hold, now)) {
    if (hold.status !== 'EXPIRED') {
      hold.status = 'EXPIRED';
      store.putHold(hold);
    }
    throw new HoldExpiredError(holdId);
  }
  if (hold.status === 'CONSUMED') {
    throw new HoldExpiredError(holdId);
  }
  return hold;
}

export function consumeHold(hold: FareHold): void {
  hold.status = 'CONSUMED';
  store.putHold(hold);
}
