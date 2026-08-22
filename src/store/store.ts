import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  Booking,
  FareHold,
  LegResult,
  Organisation,
  Session,
} from '../domain/types.js';

/**
 * JSON-file persistence.
 *
 * Deliberate (NFR-1): ~10 bookings a business day. A database would be
 * ceremony we do not need, and a file we can open and read is worth more than
 * throughput we will never use. Swap behind this interface if that changes.
 */

export interface AdminAlert {
  id: string;
  at: string;
  severity: 'WARN' | 'ERROR';
  code: string;
  message: string;
  detail?: Record<string, unknown>;
  acknowledged: boolean;
}

/** One recorded search leg, for corporate-query health (FR-SRCH-4, FR-RPT-6). */
export interface LegTelemetry extends LegResult {
  at: string;
  searchId: string;
  route: string;
}

interface Db {
  organisation: Organisation | null;
  sessions: Session[];
  holds: FareHold[];
  bookings: Booking[];
  legTelemetry: LegTelemetry[];
  alerts: AdminAlert[];
}

const EMPTY: Db = {
  organisation: null,
  sessions: [],
  holds: [],
  bookings: [],
  legTelemetry: [],
  alerts: [],
};

export class Store {
  private db: Db;

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        this.db = { ...EMPTY, ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        this.db = structuredClone(EMPTY);
      }
    } else {
      this.db = structuredClone(EMPTY);
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.db, null, 2));
  }

  // --- organisation ---------------------------------------------------------

  getOrganisation(): Organisation {
    if (!this.db.organisation) {
      throw new Error('Organisation is not configured. Run `npm run seed` first.');
    }
    return this.db.organisation;
  }

  setOrganisation(org: Organisation): void {
    this.db.organisation = org;
    this.flush();
  }

  getLegalEntity(id: string) {
    return this.getOrganisation().legalEntities.find((e) => e.id === id);
  }

  // --- sessions (CON-10) ----------------------------------------------------

  putSession(s: Session): void {
    this.db.sessions = this.db.sessions.filter((x) => x.id !== s.id);
    this.db.sessions.push(s);
    this.flush();
  }

  getSession(id: string): Session | undefined {
    return this.db.sessions.find((s) => s.id === id);
  }

  // --- holds (CON-12) -------------------------------------------------------

  putHold(h: FareHold): void {
    this.db.holds = this.db.holds.filter((x) => x.id !== h.id);
    this.db.holds.push(h);
    this.flush();
  }

  getHold(id: string): FareHold | undefined {
    return this.db.holds.find((h) => h.id === id);
  }

  // --- bookings -------------------------------------------------------------

  putBooking(b: Booking): void {
    this.db.bookings = this.db.bookings.filter((x) => x.id !== b.id);
    this.db.bookings.push(b);
    this.flush();
  }

  getBooking(id: string): Booking | undefined {
    return this.db.bookings.find((b) => b.id === id);
  }

  /** Retrieval by reference — closes the CON-10 session-scoping hole (Stage 2). */
  getBookingByReference(reference: string): Booking | undefined {
    const ref = reference.trim().toUpperCase();
    return this.db.bookings.find((b) => b.reference.toUpperCase() === ref);
  }

  getBookingByIdempotencyKey(key: string): Booking | undefined {
    return this.db.bookings.find((b) =>
      b.audit.some((a) => a.detail?.['idempotencyKey'] === key),
    );
  }

  listBookingsForSession(sessionId: string): Booking[] {
    return this.db.bookings
      .filter((b) => b.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listBookings(): Booking[] {
    return [...this.db.bookings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // --- telemetry & alerts ---------------------------------------------------

  recordLegs(entries: LegTelemetry[]): void {
    this.db.legTelemetry.push(...entries);
    // Keep the file readable; this is telemetry, not an audit record.
    if (this.db.legTelemetry.length > 5000) {
      this.db.legTelemetry = this.db.legTelemetry.slice(-5000);
    }
    this.flush();
  }

  listLegTelemetry(): LegTelemetry[] {
    return this.db.legTelemetry;
  }

  raiseAlert(a: AdminAlert): void {
    this.db.alerts.push(a);
    this.flush();
  }

  listAlerts(includeAcknowledged = false): AdminAlert[] {
    return this.db.alerts
      .filter((a) => includeAcknowledged || !a.acknowledged)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  acknowledgeAlert(id: string): void {
    const a = this.db.alerts.find((x) => x.id === id);
    if (a) {
      a.acknowledged = true;
      this.flush();
    }
  }

  /** Test hook. */
  reset(): void {
    this.db = structuredClone(EMPTY);
    this.flush();
  }
}

/**
 * Per-worker isolation under test, so parallel vitest workers do not write to
 * the same file and interfere with each other's fixtures.
 */
const workerId = process.env['VITEST_WORKER_ID'];
export const DB_FILE =
  process.env['DB_FILE'] ??
  resolve(process.cwd(), 'data', workerId ? `db.test.${workerId}.json` : 'db.json');

export const store = new Store(DB_FILE);
