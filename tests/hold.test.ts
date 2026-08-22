import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_TTL_MS, createHold, isExpired, remainingMs, requireLiveHold } from '../src/booking/hold.js';
import { HoldExpiredError } from '../src/domain/errors.js';
import { store } from '../src/store/store.js';
import { criteria, makeSession, newOrchestrator, resetWorld } from './helpers.js';

/** CON-12 / FR-BOOK-9 — a selected fare is held for exactly 5 minutes. */
describe('CON-12 — the 5 minute fare hold', () => {
  beforeEach(resetWorld);

  it('is exactly 5 minutes', () => {
    expect(HOLD_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('expires exactly 5 minutes after creation', async () => {
    const { orchestrator } = newOrchestrator();
    const session = makeSession();
    const result = await orchestrator.search(criteria());
    const hold = createHold(result.offers[0]!, session.id);

    const held = new Date(hold.heldAt).getTime();
    const expires = new Date(hold.expiresAt).getTime();
    expect(expires - held).toBe(HOLD_TTL_MS);
  });

  it('exposes remaining time so the countdown can be shown to the user', async () => {
    const { orchestrator } = newOrchestrator();
    const session = makeSession();
    const result = await orchestrator.search(criteria());
    const hold = createHold(result.offers[0]!, session.id);

    const remaining = remainingMs(hold);
    expect(remaining).toBeGreaterThan(HOLD_TTL_MS - 5_000);
    expect(remaining).toBeLessThanOrEqual(HOLD_TTL_MS);
  });

  it('is live just before the deadline and expired just after', async () => {
    const { orchestrator } = newOrchestrator();
    const session = makeSession();
    const result = await orchestrator.search(criteria());
    const hold = createHold(result.offers[0]!, session.id);
    const base = new Date(hold.heldAt).getTime();

    expect(isExpired(hold, base + HOLD_TTL_MS - 1)).toBe(false);
    expect(isExpired(hold, base + HOLD_TTL_MS + 1)).toBe(true);
  });

  it('refuses to book against an expired hold', async () => {
    const { orchestrator } = newOrchestrator();
    const session = makeSession();
    const result = await orchestrator.search(criteria());
    const hold = createHold(result.offers[0]!, session.id);

    const afterExpiry = new Date(hold.heldAt).getTime() + HOLD_TTL_MS + 1;
    expect(() => requireLiveHold(hold.id, afterExpiry)).toThrow(HoldExpiredError);
  });

  it('marks the hold EXPIRED once it lapses, so the state is not merely implied', async () => {
    const { orchestrator } = newOrchestrator();
    const session = makeSession();
    const result = await orchestrator.search(criteria());
    const hold = createHold(result.offers[0]!, session.id);

    const afterExpiry = new Date(hold.heldAt).getTime() + HOLD_TTL_MS + 1;
    try {
      requireLiveHold(hold.id, afterExpiry);
    } catch {
      /* expected */
    }
    expect(store.getHold(hold.id)?.status).toBe('EXPIRED');
  });

  it('cites CON-12 when rejecting', async () => {
    const { orchestrator } = newOrchestrator();
    const session = makeSession();
    const result = await orchestrator.search(criteria());
    const hold = createHold(result.offers[0]!, session.id);
    try {
      requireLiveHold(hold.id, Date.now() + HOLD_TTL_MS + 1);
      expect.unreachable();
    } catch (err) {
      expect((err as HoldExpiredError).constraintRef).toBe('CON-12');
    }
  });
});
