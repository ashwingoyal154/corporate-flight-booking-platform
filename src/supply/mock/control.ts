import type { CarrierCode, FareType } from '../../domain/types.js';

/**
 * Failure injection for the mock provider.
 *
 * Exists to make Stage 2 demonstrable and testable: the point of FR-SRCH-4 is
 * that a corporate query which fails must never render as "no corporate fare
 * available", and the only way to prove that is to break it on purpose.
 */
export type InjectedFailure =
  | 'AUTH_FAILURE'
  | 'TIMEOUT'
  | 'NO_INVENTORY'
  | 'MISCONFIGURED'
  | 'PROVIDER_ERROR';

interface LegInjection {
  carrier?: CarrierCode;
  fareScope?: FareType;
  failure: InjectedFailure;
}

class MockControl {
  private legInjections: LegInjection[] = [];
  /** Fractional price movement applied on the next price() call (FR-BOOK-5). */
  private priceDelta: number | null = null;
  /**
   * Simulates a ticket being issued and the response then being lost.
   * The retry must return the same booking, never issue a second ticket
   * (FR-BOOK-7, NFR-5).
   */
  private dropNextBookResponse = false;
  /** Artificial latency in ms, to exercise the 5s search budget (CON-11). */
  private latencyMs = 0;

  failLeg(injection: LegInjection): void {
    this.legInjections.push(injection);
  }

  matchLeg(carrier: CarrierCode, fareScope: FareType): InjectedFailure | null {
    const hit = this.legInjections.find(
      (i) =>
        (i.carrier === undefined || i.carrier === carrier) &&
        (i.fareScope === undefined || i.fareScope === fareScope),
    );
    return hit?.failure ?? null;
  }

  setPriceDelta(delta: number | null): void {
    this.priceDelta = delta;
  }

  takePriceDelta(): number | null {
    const d = this.priceDelta;
    this.priceDelta = null;
    return d;
  }

  armDroppedBookResponse(): void {
    this.dropNextBookResponse = true;
  }

  takeDroppedBookResponse(): boolean {
    const v = this.dropNextBookResponse;
    this.dropNextBookResponse = false;
    return v;
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  get latency(): number {
    return this.latencyMs;
  }

  reset(): void {
    this.legInjections = [];
    this.priceDelta = null;
    this.dropNextBookResponse = false;
    this.latencyMs = 0;
  }

  describe(): Record<string, unknown> {
    return {
      legInjections: this.legInjections,
      priceDelta: this.priceDelta,
      dropNextBookResponse: this.dropNextBookResponse,
      latencyMs: this.latencyMs,
    };
  }
}

export const mockControl = new MockControl();
