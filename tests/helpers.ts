import { store } from '../src/store/store.js';
import { seed } from '../src/store/seed.js';
import { mockControl } from '../src/supply/mock/control.js';
import { MockAdapter } from '../src/supply/mock/MockAdapter.js';
import { SearchOrchestrator } from '../src/search/orchestrator.js';
import type { SearchCriteria, Session } from '../src/domain/types.js';
import { id } from '../src/domain/ids.js';

export function resetWorld(): void {
  store.reset();
  seed();
  mockControl.reset();
}

export function makeSession(legalEntityId?: string): Session {
  const org = store.getOrganisation();
  const session: Session = {
    id: id('sess'),
    legalEntityId: legalEntityId ?? org.legalEntities[0]!.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  store.putSession(session);
  return session;
}

export function entityFor(session: Session) {
  const e = store.getLegalEntity(session.legalEntityId);
  if (!e) throw new Error('seed entity missing');
  return e;
}

/** A date far enough out that fares are stable and not urgency-priced. */
export function futureDate(daysOut = 30): string {
  return new Date(Date.now() + daysOut * 86_400_000).toISOString().slice(0, 10);
}

export function criteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    origin: 'DEL',
    destination: 'BOM',
    departDate: futureDate(),
    passengers: 1,
    cabin: 'ECONOMY',
    ...overrides,
  };
}

export function newOrchestrator(provider = new MockAdapter()): {
  provider: MockAdapter;
  orchestrator: SearchOrchestrator;
} {
  return { provider, orchestrator: new SearchOrchestrator(provider, store.getOrganisation()) };
}

export const PASSENGER = {
  firstName: 'Asha',
  lastName: 'Menon',
  email: 'asha.menon@consultco.example',
  phone: '+919812345678',
};
