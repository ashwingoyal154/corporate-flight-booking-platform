import type { CarrierCode, FareType } from '../../domain/types.js';
import { rupees } from '../../domain/money.js';

export interface Airport {
  code: string;
  city: string;
  name: string;
  stateCode: string;
}

/** Indian domestic network. `stateCode` feeds place-of-supply reasoning. */
export const AIRPORTS: Airport[] = [
  { code: 'DEL', city: 'Delhi', name: 'Indira Gandhi Intl', stateCode: '07' },
  { code: 'BOM', city: 'Mumbai', name: 'Chhatrapati Shivaji Maharaj Intl', stateCode: '27' },
  { code: 'BLR', city: 'Bengaluru', name: 'Kempegowda Intl', stateCode: '29' },
  { code: 'HYD', city: 'Hyderabad', name: 'Rajiv Gandhi Intl', stateCode: '36' },
  { code: 'MAA', city: 'Chennai', name: 'Chennai Intl', stateCode: '33' },
  { code: 'CCU', city: 'Kolkata', name: 'Netaji Subhas Chandra Bose Intl', stateCode: '19' },
  { code: 'PNQ', city: 'Pune', name: 'Pune Airport', stateCode: '27' },
  { code: 'AMD', city: 'Ahmedabad', name: 'Sardar Vallabhbhai Patel Intl', stateCode: '24' },
  { code: 'GOI', city: 'Goa', name: 'Manohar Intl', stateCode: '30' },
  { code: 'JAI', city: 'Jaipur', name: 'Jaipur Intl', stateCode: '08' },
  { code: 'COK', city: 'Kochi', name: 'Cochin Intl', stateCode: '32' },
];

export const AIRPORT_BY_CODE = new Map(AIRPORTS.map((a) => [a.code, a]));

const COORDS: Record<string, [number, number]> = {
  DEL: [28.56, 77.1],
  BOM: [19.09, 72.87],
  BLR: [13.2, 77.71],
  HYD: [17.24, 78.43],
  MAA: [12.99, 80.17],
  CCU: [22.65, 88.45],
  PNQ: [18.58, 73.92],
  AMD: [23.07, 72.63],
  GOI: [15.38, 73.83],
  JAI: [26.82, 75.8],
  COK: [10.15, 76.39],
};

export function distanceKm(a: string, b: string): number {
  const p = COORDS[a];
  const q = COORDS[b];
  if (!p || !q) return 1200;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lat1, lon1] = p;
  const [lat2, lon2] = q;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)));
}

/**
 * Change and cancellation fees, in paise.
 *
 * The CORPORATE figures are grounded in research.md §4: corporate programmes
 * REDUCE these fees, they do not waive them (CON-8). Akasa is the genuine
 * outlier — fee-free changes up to one hour before departure.
 *
 * RETAIL figures are representative published fees (mock data).
 */
export const FEE_TABLE: Record<CarrierCode, Record<FareType, { change: number; cancel: number }>> = {
  '6E': {
    RETAIL: { change: rupees(2999), cancel: rupees(2999) },
    // research.md §4: cancel ~₹999-1,499; reschedule from ~₹499
    CORPORATE: { change: rupees(499), cancel: rupees(1199) },
  },
  AI: {
    RETAIL: { change: rupees(3000), cancel: rupees(3000) },
    // research.md §4: ~₹2,300 within 6-74h, ~₹1,300 outside
    CORPORATE: { change: rupees(1300), cancel: rupees(2300) },
  },
  QP: {
    RETAIL: { change: rupees(2750), cancel: rupees(2750) },
    // research.md §4: no change/cancel fee to T-1h domestic; corporate cancel ~₹250
    CORPORATE: { change: 0, cancel: rupees(250) },
  },
  SG: {
    RETAIL: { change: rupees(3000), cancel: rupees(3000) },
    // research.md §4: change AND cancel ~₹450 up to T-6h
    CORPORATE: { change: rupees(450), cancel: rupees(450) },
  },
};

/** Akasa's fee-free change window — the one genuine differentiator found (research.md §4.3). */
export const FREE_CHANGE_WINDOW_HOURS: Partial<Record<CarrierCode, number>> = { QP: 1 };

export const FARE_BRANDS: Record<CarrierCode, Record<FareType, string>> = {
  '6E': { RETAIL: 'Super 6E', CORPORATE: '6E Corporate Flexi' },
  AI: { RETAIL: 'Comfort', CORPORATE: 'AI BIZ Corporate' },
  QP: { RETAIL: 'Akasa Value', CORPORATE: 'Akasa SME Business' },
  SG: { RETAIL: 'SpiceSaver', CORPORATE: 'SpiceJet Corporate' },
};

export const INCLUSIONS: Record<CarrierCode, Record<FareType, string[]>> = {
  '6E': {
    RETAIL: ['7kg cabin bag', '15kg check-in'],
    // Unlocked by SSR CPTR (FR-BOOK-4, research.md §3.4)
    CORPORATE: ['7kg cabin bag', '20kg check-in', 'Complimentary meal', 'Free seat selection'],
  },
  AI: {
    RETAIL: ['7kg cabin bag', '15kg check-in', 'Meal'],
    CORPORATE: ['7kg cabin bag', '25kg check-in', 'Meal', 'Free seat selection', 'Maharaja Points'],
  },
  QP: {
    RETAIL: ['7kg cabin bag', '15kg check-in'],
    CORPORATE: ['7kg cabin bag', '20kg check-in', 'Complimentary snack & beverage', 'Standard seat'],
  },
  SG: {
    RETAIL: ['7kg cabin bag', '15kg check-in'],
    CORPORATE: ['7kg cabin bag', '20kg check-in', 'Meal & beverage', 'Preferred seating'],
  },
};

/** Base fare per km, in paise, before carrier and demand adjustment. */
export const CARRIER_RATE: Record<CarrierCode, number> = {
  '6E': 610,
  AI: 720,
  QP: 585,
  SG: 560,
};

export const SCHEDULE: Record<CarrierCode, Array<{ dep: string; num: string }>> = {
  '6E': [
    { dep: '06:15', num: '6E-2134' },
    { dep: '09:40', num: '6E-5017' },
    { dep: '14:20', num: '6E-6423' },
    { dep: '19:05', num: '6E-778' },
  ],
  AI: [
    { dep: '07:30', num: 'AI-805' },
    { dep: '12:10', num: 'AI-639' },
    { dep: '18:45', num: 'AI-441' },
  ],
  QP: [
    { dep: '08:05', num: 'QP-1102' },
    { dep: '16:30', num: 'QP-1408' },
  ],
  SG: [
    { dep: '10:25', num: 'SG-8721' },
    { dep: '20:15', num: 'SG-3345' },
  ],
};

/**
 * Corporate discount off base fare.
 *
 * 5-10% is the only credible researched band (research.md §6.2 — ITILITE's
 * published figure for airlines specifically). Marketing ceilings of 30% are
 * NOT achievable and are deliberately not modelled here.
 */
export const CORPORATE_DISCOUNT_BAND = { min: 0.05, max: 0.1 };
