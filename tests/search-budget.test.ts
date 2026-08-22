import { beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_BUDGET_MS } from '../src/search/orchestrator.js';
import { mockControl } from '../src/supply/mock/control.js';
import { criteria, makeSession, newOrchestrator, resetWorld } from './helpers.js';

/**
 * CON-11 / FR-SRCH-9 / NFR-2 — search returns in under 5 seconds.
 *
 * A hard wall-clock budget, not a target. The dual-search design (CON-1/CON-2)
 * means a slow corporate leg is a normal occurrence, so the deadline is what
 * keeps the product usable.
 */
describe('CON-11 — the 5 second search budget', () => {
  beforeEach(resetWorld);

  it('declares a 5 second budget', () => {
    expect(SEARCH_BUDGET_MS).toBe(5_000);
  });

  it('returns quickly when all legs are healthy, with no artificial delay', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const start = Date.now();
    const result = await orchestrator.search(criteria());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(SEARCH_BUDGET_MS);
    expect(result.partial).toBe(false);
    expect(result.offers.length).toBeGreaterThan(0);
  });

  it('returns within the budget even when a corporate leg hangs', async () => {
    // The mock sleeps 30s on TIMEOUT; only the deadline can cut that off.
    mockControl.failLeg({ carrier: '6E', fareScope: 'CORPORATE', failure: 'TIMEOUT' });
    const { orchestrator } = newOrchestrator();
    makeSession();

    const start = Date.now();
    const result = await orchestrator.search(criteria());
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(SEARCH_BUDGET_MS + 750);
    expect(result.partial).toBe(true);
  });

  it('still returns the healthy legs when one leg times out (FR-SRCH-7)', async () => {
    mockControl.failLeg({ carrier: '6E', fareScope: 'CORPORATE', failure: 'TIMEOUT' });
    const { orchestrator } = newOrchestrator();
    makeSession();

    const result = await orchestrator.search(criteria());

    // Retail 6E and every other carrier must still be present — a slow
    // corporate leg never blocks retail rendering (NFR-2).
    expect(result.offers.some((o) => o.carrier === '6E' && o.fareType === 'RETAIL')).toBe(true);
    expect(result.offers.some((o) => o.carrier === 'AI' && o.fareType === 'CORPORATE')).toBe(true);
    const timedOut = result.legs.find((l) => l.carrier === '6E' && l.fareType === 'CORPORATE');
    expect(timedOut?.outcome).toBe('TIMEOUT');
  });

  it('records elapsed time on the result', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    const result = await orchestrator.search(criteria());
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThan(SEARCH_BUDGET_MS);
  });
});
