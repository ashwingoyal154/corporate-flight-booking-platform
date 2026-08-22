import type { Organisation } from '../domain/types.js';
import { store } from './store.js';

/**
 * Seeded configuration.
 *
 * Through stages 1-2 configuration is a seeded file, not an admin UI — that
 * arrives in Stage 4 (FR-ORG-1, FR-ORG-2). The shape here is already the shape
 * the admin UI will write, so Stage 4 is a UI on top of this, not a migration.
 */
export const SEED_ORGANISATION: Organisation = {
  id: 'org_consultco',
  name: 'ConsultCo Advisory Services Pvt Ltd',

  legalEntities: [
    {
      id: 'le_karnataka',
      name: 'ConsultCo — Karnataka',
      gstin: '29AABCC1234D1Z5',
      registeredName: 'CONSULTCO ADVISORY SERVICES PRIVATE LIMITED',
      stateCode: '29',
      invoiceEmail: 'ap.bengaluru@consultco.example',
      address: 'Level 8, Prestige Tower, Bengaluru 560001',
    },
    {
      id: 'le_maharashtra',
      name: 'ConsultCo — Maharashtra',
      gstin: '27AABCC1234D1ZH',
      registeredName: 'CONSULTCO ADVISORY SERVICES PRIVATE LIMITED',
      stateCode: '27',
      invoiceEmail: 'ap.mumbai@consultco.example',
      address: 'Nariman Point, Mumbai 400021',
    },
  ],

  /**
   * Corporate fare identity is configuration, never code (CON-7).
   *
   * Note the mechanism split, which mirrors research.md §3:
   *   6E — CREDENTIAL: IndiGo corporate content requires its own Agency ID/PCC
   *        and can never be combined with retail (CON-1).
   *   AI — ACCOUNT_CODE: full-service carrier, code sent in the shopping request.
   *   QP — PROMO_CODE: Akasa SME programme.
   *   SG — CONTRACT_CODE: negotiated contract.
   */
  corporateFareConfigs: [
    {
      carrier: '6E',
      mechanism: 'CREDENTIAL',
      credentialRef: 'secret://supply/indigo/corporate-agency-id',
      tourCode: 'CONSULTCO6E',
      activeFrom: '2026-01-01',
    },
    {
      carrier: 'AI',
      mechanism: 'ACCOUNT_CODE',
      credentialRef: 'secret://supply/airindia/corporate',
      code: 'AIBIZ44821',
      tourCode: 'CONSULTCOAI',
      activeFrom: '2026-01-01',
    },
    {
      carrier: 'QP',
      mechanism: 'PROMO_CODE',
      credentialRef: 'secret://supply/akasa/sme',
      code: 'CSME04PS',
      activeFrom: '2026-01-01',
    },
    {
      carrier: 'SG',
      mechanism: 'CONTRACT_CODE',
      credentialRef: 'secret://supply/spicejet/corporate',
      code: 'SGCORP7781',
      tourCode: 'CONSULTCOSG',
      activeFrom: '2026-01-01',
    },
  ],

  /**
   * GST rates are configuration, never hardcoded (FR-GST-5).
   *
   * 5% economy / 18% premium as of the spec date — UNVERIFIED against a primary
   * CBIC notification (DEC-6). Rates reportedly changed in the 2025
   * rationalisation, which is precisely why this must not be a constant.
   */
  gstRates: { economy: 0.05, premium: 0.18 },
};

export function seed(): void {
  // Deep-clone: SEED_ORGANISATION is a module-level constant, and handing it
  // out by reference lets any later mutation of the stored organisation leak
  // back into the seed for the lifetime of the process.
  store.setOrganisation(structuredClone(SEED_ORGANISATION));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
  console.log('Seeded organisation:', SEED_ORGANISATION.name);
  console.log('Legal entities:', SEED_ORGANISATION.legalEntities.map((e) => e.gstin).join(', '));
  console.log('Corporate fare configs:', SEED_ORGANISATION.corporateFareConfigs.length);
}
