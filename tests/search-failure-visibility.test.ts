import { beforeEach, describe, expect, it } from 'vitest';
import { mockControl } from '../src/supply/mock/control.js';
import { store } from '../src/store/store.js';
import { criteria, makeSession, newOrchestrator, resetWorld } from './helpers.js';

/**
 * FR-SRCH-4 — the failure mode that quietly destroys the whole thesis.
 *
 * A corporate query that fails looks exactly like "no corporate fare available"
 * unless the system distinguishes them. The product would report a healthy
 * attach rate while delivering nothing. Every one of these tests exists to make
 * that impossible.
 */
describe('FR-SRCH-4 — a failed corporate query is never reported as "no fare available"', () => {
  beforeEach(resetWorld);

  it.each(['AUTH_FAILURE', 'MISCONFIGURED', 'PROVIDER_ERROR', 'TIMEOUT'] as const)(
    'classifies %s as our failure, not absent inventory',
    async (failure) => {
      mockControl.failLeg({ carrier: '6E', fareScope: 'CORPORATE', failure });
      const { orchestrator } = newOrchestrator();
      makeSession();

      const result = await orchestrator.search(criteria());
      const leg = result.legs.find((l) => l.carrier === '6E' && l.fareType === 'CORPORATE');

      expect(leg?.outcome).toBe(failure);
      expect(leg?.outcome).not.toBe('NO_INVENTORY');
      // The load-bearing assertion: the UI is told corporate could not be checked.
      expect(result.corporateUnavailableDueToFailure).toBe(true);
    },
  );

  it('distinguishes genuine NO_INVENTORY from a failure', async () => {
    mockControl.failLeg({ carrier: '6E', fareScope: 'CORPORATE', failure: 'NO_INVENTORY' });
    const { orchestrator } = newOrchestrator();
    makeSession();

    const result = await orchestrator.search(criteria());
    const leg = result.legs.find((l) => l.carrier === '6E' && l.fareType === 'CORPORATE');

    expect(leg?.outcome).toBe('NO_INVENTORY');
    // The airline genuinely had nothing — this is the ONE case where telling the
    // traveller "no corporate fare" is honest.
    expect(result.corporateUnavailableDueToFailure).toBe(false);
  });

  it('raises an admin alert when a corporate leg fails', async () => {
    mockControl.failLeg({ carrier: '6E', fareScope: 'CORPORATE', failure: 'AUTH_FAILURE' });
    const { orchestrator } = newOrchestrator();
    makeSession();

    await orchestrator.search(criteria());

    const alerts = store.listAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    const alert = alerts.find((a) => a.code === 'CORPORATE_LEG_AUTH_FAILURE');
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe('ERROR');
    expect(alert?.message).toContain('IndiGo');
    expect(alert?.message).toContain('retail fares only');
  });

  it('does NOT alert when the corporate leg succeeds', async () => {
    const { orchestrator } = newOrchestrator();
    makeSession();
    await orchestrator.search(criteria());
    expect(store.listAlerts().filter((a) => a.code.startsWith('CORPORATE_LEG_'))).toHaveLength(0);
  });

  it('records leg telemetry for corporate query health (FR-RPT-6)', async () => {
    mockControl.failLeg({ carrier: 'AI', fareScope: 'CORPORATE', failure: 'AUTH_FAILURE' });
    const { orchestrator } = newOrchestrator();
    makeSession();
    await orchestrator.search(criteria());

    const telemetry = store.listLegTelemetry();
    // 4 carriers x 2 legs each = 8 recorded legs.
    expect(telemetry.length).toBe(8);
    const aiCorp = telemetry.find((t) => t.carrier === 'AI' && t.fareType === 'CORPORATE');
    expect(aiCorp?.outcome).toBe('AUTH_FAILURE');
    expect(aiCorp?.route).toBe('DEL-BOM');
  });

  it('a credential provisioned for the wrong scope is MISCONFIGURED, not empty results', async () => {
    // CON-1: a retail credential cannot see corporate content and vice versa.
    const { provider } = newOrchestrator();
    await expect(
      provider.search({
        criteria: criteria(),
        carrier: '6E',
        credential: { ref: 'secret://supply/6e/retail', fareScope: 'RETAIL' },
        fareScope: 'CORPORATE',
        mechanism: 'CREDENTIAL',
      }),
    ).rejects.toThrow(/provisioned for RETAIL/);
  });
});
