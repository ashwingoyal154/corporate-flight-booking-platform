import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiFailure, api, inr, timeOf } from './api.js';

type View = 'search' | 'results' | 'checkout' | 'confirmed' | 'bookings' | 'ops';

const CARRIERS: Record<string, string> = {
  '6E': 'IndiGo',
  AI: 'Air India',
  QP: 'Akasa Air',
  SG: 'SpiceJet',
};

function Err({ e }: { e: ApiFailure | null }) {
  if (!e) return null;
  return (
    <div className="banner error">
      <strong>{e.payload.error}</strong>
      {e.payload.constraintRef && e.payload.constraintRef !== '-' && (
        <div className="constraint">
          enforced by {e.payload.constraintRef} · {e.payload.code}
        </div>
      )}
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>('search');
  const [config, setConfig] = useState<any>(null);
  const [entity, setEntity] = useState<any>(null);
  const [error, setError] = useState<ApiFailure | null>(null);

  const [criteria, setCriteria] = useState({
    origin: 'DEL',
    destination: 'BOM',
    departDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
    passengers: 1,
    cabin: 'ECONOMY' as 'ECONOMY' | 'PREMIUM',
  });
  const [result, setResult] = useState<any>(null);
  const [searching, setSearching] = useState(false);
  const [hold, setHold] = useState<any>(null);
  const [holdMeta, setHoldMeta] = useState<any>(null);
  const [booking, setBooking] = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.config();
        setConfig(cfg);
        try {
          const s = await api.session();
          setEntity(s.entity);
        } catch {
          const s = await api.startSession();
          setEntity(s.entity);
        }
      } catch (e) {
        if (e instanceof ApiFailure) setError(e);
      }
    })();
  }, []);

  const runSearch = useCallback(async () => {
    setSearching(true);
    setError(null);
    try {
      setResult(await api.search(criteria));
      setView('results');
    } catch (e) {
      if (e instanceof ApiFailure) setError(e);
    } finally {
      setSearching(false);
    }
  }, [criteria]);

  const select = useCallback(async (offerId: string) => {
    setError(null);
    try {
      const h = await api.hold([offerId]);
      setHold(h.hold);
      setHoldMeta(h);
      setView('checkout');
    } catch (e) {
      if (e instanceof ApiFailure) setError(e);
    }
  }, []);

  return (
    <div className="wrap">
      <header className="top">
        <h1>ConsultCo Travel</h1>
        <span className="tag">
          corporate flight booking · prototype (stages 1–2) · mock supply
        </span>
        <nav>
          <button className={view === 'search' ? 'active' : ''} onClick={() => setView('search')}>
            Search
          </button>
          <button className={view === 'bookings' ? 'active' : ''} onClick={() => setView('bookings')}>
            Bookings
          </button>
          <button className={view === 'ops' ? 'active' : ''} onClick={() => setView('ops')}>
            Ops
          </button>
        </nav>
      </header>

      <Err e={error} />

      {view === 'search' && (
        <SearchView
          config={config}
          entity={entity}
          criteria={criteria}
          setCriteria={setCriteria}
          onSearch={runSearch}
          searching={searching}
        />
      )}

      {view === 'results' && result && (
        <ResultsView result={result} onSelect={select} onBack={() => setView('search')} />
      )}

      {view === 'checkout' && hold && (
        <CheckoutView
          hold={hold}
          meta={holdMeta}
          entity={entity}
          onCancel={() => setView('results')}
          onBooked={(b: any) => {
            setBooking(b);
            setView('confirmed');
          }}
          onError={setError}
        />
      )}

      {view === 'confirmed' && booking && (
        <ConfirmationView booking={booking} onDone={() => setView('bookings')} />
      )}

      {view === 'bookings' && <BookingsView onError={setError} />}
      {view === 'ops' && <OpsView />}

      <DevBar onReset={() => setResult(null)} />
    </div>
  );
}

function SearchView({ config, entity, criteria, setCriteria, onSearch, searching }: any) {
  const airports = config?.airports ?? [];
  return (
    <>
      <div className="card">
        <h2>Search flights</h2>
        <div className="row">
          <div>
            <label>From</label>
            <select
              value={criteria.origin}
              onChange={(e) => setCriteria({ ...criteria, origin: e.target.value })}
            >
              {airports.map((a: any) => (
                <option key={a.code} value={a.code}>
                  {a.code} — {a.city}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>To</label>
            <select
              value={criteria.destination}
              onChange={(e) => setCriteria({ ...criteria, destination: e.target.value })}
            >
              {airports.map((a: any) => (
                <option key={a.code} value={a.code}>
                  {a.code} — {a.city}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Departure</label>
            <input
              type="date"
              value={criteria.departDate}
              onChange={(e) => setCriteria({ ...criteria, departDate: e.target.value })}
            />
          </div>
          <div>
            <label>Cabin</label>
            <select
              value={criteria.cabin}
              onChange={(e) => setCriteria({ ...criteria, cabin: e.target.value })}
            >
              <option value="ECONOMY">Economy</option>
              <option value="PREMIUM">Premium</option>
            </select>
          </div>
          <button className="primary" onClick={onSearch} disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {entity && (
        <div className="card">
          <h3>Billing entity</h3>
          <dl className="kv">
            <dt>Legal entity</dt>
            <dd>{entity.name}</dd>
            <dt>GSTIN</dt>
            <dd className="mono">{entity.gstin}</dd>
            <dt>Registered name</dt>
            <dd>{entity.registeredName}</dd>
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>
            GST details are pre-filled from configuration and cannot be edited at booking. They cannot be
            added or corrected after ticketing, so a booking without them is blocked outright.
          </p>
        </div>
      )}
    </>
  );
}

function ResultsView({ result, onSelect, onBack }: any) {
  const corporate = result.offers.filter((o: any) => o.fareType === 'CORPORATE');
  const retail = result.offers.filter((o: any) => o.fareType === 'RETAIL');
  const failedLegs = result.legs.filter(
    (l: any) => l.fareType === 'CORPORATE' && l.outcome !== 'SUCCESS' && l.outcome !== 'NO_INVENTORY',
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="ghost" onClick={onBack}>
          ← New search
        </button>
        <span className="muted small">
          {result.criteria.origin} → {result.criteria.destination} · {result.criteria.departDate} ·
          returned in {result.elapsedMs}ms
        </span>
      </div>

      {/* FR-SRCH-4: a failed corporate query must never read as "no corporate fare". */}
      {result.corporateUnavailableDueToFailure && (
        <div className="banner error">
          <strong>Corporate fares could not be checked for some airlines.</strong>
          <div className="small" style={{ marginTop: 4 }}>
            This is a problem on our side, not an absence of corporate fares. You are seeing retail
            prices for:{' '}
            {failedLegs.map((l: any) => `${CARRIERS[l.carrier]} (${l.outcome})`).join(', ')}. The travel
            desk has been alerted.
          </div>
        </div>
      )}

      {result.partial && (
        <div className="banner warn">
          Some airlines did not respond within the 5 second search budget. Showing what returned in time.
        </div>
      )}

      <h2>Corporate fares</h2>
      {corporate.length === 0 && (
        <div className="banner info">
          No corporate fares were returned for this route on this date.
        </div>
      )}
      <div className="grid" style={{ marginBottom: 24 }}>
        {corporate.map((o: any) => (
          <Offer key={o.id} o={o} onSelect={onSelect} />
        ))}
      </div>

      <h2>Retail fares</h2>
      <div className="grid">
        {retail.map((o: any) => (
          <Offer key={o.id} o={o} onSelect={onSelect} />
        ))}
      </div>
    </>
  );
}

function Offer({ o, onSelect }: any) {
  const seg = o.segments[0];
  const isCorp = o.fareType === 'CORPORATE';
  return (
    <div className={`offer ${isCorp ? 'corporate' : ''}`}>
      <div className="offer-head">
        <div>
          <div className="flight">
            {CARRIERS[o.carrier]} {seg.flightNumber}
            <span className={`badge ${isCorp ? 'corp' : 'retail'}`} style={{ marginLeft: 8 }}>
              {isCorp ? 'CORPORATE FARE' : 'Retail'}
            </span>
            {isCorp && o.savingVsRetail > 0 && (
              <span className="badge save" style={{ marginLeft: 6 }}>
                {inr(o.savingVsRetail)} below retail
              </span>
            )}
          </div>
          <div className="muted small">
            {timeOf(seg.departsAt)} → {timeOf(seg.arrivesAt)} · {seg.origin}–{seg.destination} ·{' '}
            {o.fareBrand}
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            {o.inclusions.join(' · ')}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            Change {inr(o.landedCost.changeFee)} · Cancel {inr(o.landedCost.cancelFee)}
          </div>
        </div>
        <div className="price">
          <div className="total">{inr(o.landedCost.totalPayable)}</div>
          <div className="itc">incl. {inr(o.price.gstAmount)} GST</div>
          {/* FR-DISP-2: landed cost, not headline fare. */}
          <div className="net">net {inr(o.landedCost.netCost)} after ITC</div>
          <button className="primary" style={{ marginTop: 8 }} onClick={() => onSelect(o.id)}>
            Select
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckoutView({ hold, meta, entity, onCancel, onBooked, onError }: any) {
  const [remaining, setRemaining] = useState(meta?.remainingMs ?? 0);
  const [pax, setPax] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });
  const [busy, setBusy] = useState(false);
  const [priceChange, setPriceChange] = useState<{ oldTotal: number; newTotal: number } | null>(null);
  const idempotencyKey = useMemo(() => `idem_${Math.random().toString(36).slice(2)}${Date.now()}`, []);

  useEffect(() => {
    const t = setInterval(() => {
      const left = new Date(hold.expiresAt).getTime() - Date.now();
      setRemaining(Math.max(0, left));
    }, 250);
    return () => clearInterval(t);
  }, [hold]);

  const expired = remaining <= 0;
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);

  const pay = async (acceptedTotal?: number) => {
    setBusy(true);
    try {
      // CON-13: the token is issued without card data ever reaching our server.
      const { token } = await api.token();
      const res = await api.book({
        holdId: hold.id,
        passengers: [pax],
        paymentToken: token,
        idempotencyKey,
        ...(acceptedTotal !== undefined ? { acceptedTotal } : {}),
      });
      onBooked(res.booking);
    } catch (e) {
      if (e instanceof ApiFailure) {
        if (e.payload.code === 'PRICE_CHANGED') {
          const d = e.payload.detail as any;
          setPriceChange({ oldTotal: d.oldTotal, newTotal: d.newTotal });
        } else {
          onError(e);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const o = hold.offer;
  const complete = pax.firstName && pax.lastName && pax.email && pax.phone;

  return (
    <div className="split">
      <div>
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Confirm and pay</h2>
            <div>
              <span className="muted small">fare held </span>
              <span className={`countdown ${remaining < 60000 ? 'low' : ''}`}>
                {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
              </span>
            </div>
          </div>
          {expired && (
            <div className="banner warn" style={{ marginTop: 12 }}>
              The 5 minute hold has expired. The fare must be re-priced before booking — go back and
              select again.
            </div>
          )}
        </div>

        <div className="card">
          <h3>Traveller</h3>
          <div className="row">
            <div>
              <label>First name</label>
              <input value={pax.firstName} onChange={(e) => setPax({ ...pax, firstName: e.target.value })} />
            </div>
            <div>
              <label>Last name</label>
              <input value={pax.lastName} onChange={(e) => setPax({ ...pax, lastName: e.target.value })} />
            </div>
            <div>
              <label>Email</label>
              <input value={pax.email} onChange={(e) => setPax({ ...pax, email: e.target.value })} />
            </div>
            <div>
              <label>Phone</label>
              <input value={pax.phone} onChange={(e) => setPax({ ...pax, phone: e.target.value })} />
            </div>
          </div>
        </div>

        <div className="card">
          <h3>GST details</h3>
          <div className="row">
            <div>
              <label>GSTIN (pre-filled, not editable)</label>
              <input readOnly value={entity?.gstin ?? ''} className="mono" />
            </div>
            <div style={{ flex: 1 }}>
              <label>Registered legal name</label>
              <input readOnly value={entity?.registeredName ?? ''} style={{ width: '100%' }} />
            </div>
          </div>
          {meta?.placeOfSupply?.mismatch && (
            <div className="banner warn" style={{ marginTop: 12 }}>
              {meta.placeOfSupply.message}
            </div>
          )}
        </div>

        <div className="card">
          <h3>Payment</h3>
          <p className="small muted">
            Card details are tokenised by the payment provider in the browser. This server never receives,
            stores or logs a card number — any request carrying one is rejected outright.
          </p>
          {priceChange && (
            <div className="banner warn">
              <strong>The fare price changed while you were booking.</strong>
              <div className="small" style={{ margin: '6px 0' }}>
                {inr(priceChange.oldTotal)} → <strong>{inr(priceChange.newTotal)}</strong>. Nothing has
                been charged. Confirm the new price to continue.
              </div>
              <button className="primary" onClick={() => pay(priceChange.newTotal)} disabled={busy}>
                Accept {inr(priceChange.newTotal)} and book
              </button>
            </div>
          )}
          <div className="row">
            <button
              className="primary"
              disabled={busy || expired || !complete || !!priceChange}
              onClick={() => pay()}
            >
              {busy ? 'Booking…' : `Pay ${inr(o.landedCost.totalPayable)}`}
            </button>
            <button className="ghost" onClick={onCancel}>
              Back to results
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>
          {CARRIERS[o.carrier]} {o.segments[0].flightNumber}{' '}
          <span className={`badge ${o.fareType === 'CORPORATE' ? 'corp' : 'retail'}`}>
            {o.fareType}
          </span>
        </h3>
        <div className="muted small" style={{ marginBottom: 12 }}>
          {o.segments[0].origin} → {o.segments[0].destination} · {timeOf(o.segments[0].departsAt)}
        </div>
        <dl className="kv">
          <dt>Base fare</dt>
          <dd>{inr(o.price.baseFare)}</dd>
          <dt>Taxes & fees</dt>
          <dd>{inr(o.price.taxesAndFees)}</dd>
          <dt>GST @ {(o.price.gstRate * 100).toFixed(0)}%</dt>
          <dd>{inr(o.price.gstAmount)}</dd>
          <dt>
            <strong>Total payable</strong>
          </dt>
          <dd>
            <strong>{inr(o.landedCost.totalPayable)}</strong>
          </dd>
          <dt>Recoverable ITC</dt>
          <dd style={{ color: 'var(--good)' }}>− {inr(o.landedCost.recoverableItc)}</dd>
          <dt>
            <strong>Net cost</strong>
          </dt>
          <dd>
            <strong style={{ color: 'var(--good)' }}>{inr(o.landedCost.netCost)}</strong>
          </dd>
        </dl>
      </div>
    </div>
  );
}

function ConfirmationView({ booking, onDone }: any) {
  return (
    <>
      <div className="banner ok">
        <strong>Booked.</strong> Reference <span className="mono">{booking.reference}</span> · PNR{' '}
        <span className="mono">{booking.pnr}</span>
      </div>
      <div className="card">
        <h2>Keep this reference</h2>
        <p className="small muted">
          There is no login in this prototype, so bookings live with your browser session. The reference
          above is how you find this booking again from anywhere — write it down.
        </p>
        <dl className="kv">
          <dt>Ticket</dt>
          <dd className="mono">{booking.ticketNumbers.join(', ')}</dd>
          <dt>Fare type</dt>
          <dd>
            {booking.corporateFareApplied ? (
              <span className="badge corp">CORPORATE FARE APPLIED</span>
            ) : (
              <span className="badge retail">Retail</span>
            )}
          </dd>
          <dt>Total paid</dt>
          <dd>{inr(booking.offer.landedCost.totalPayable)}</dd>
          <dt>Recoverable ITC</dt>
          <dd style={{ color: 'var(--good)' }}>{inr(booking.offer.landedCost.recoverableItc)}</dd>
          <dt>GSTIN on invoice</dt>
          <dd className="mono">{booking.gst.gstin}</dd>
        </dl>
        <button className="primary" style={{ marginTop: 14 }} onClick={onDone}>
          View my bookings
        </button>
      </div>
    </>
  );
}

function BookingsView({ onError }: any) {
  const [bookings, setBookings] = useState<any[]>([]);
  const [ref, setRef] = useState('');
  const [found, setFound] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      setBookings((await api.myBookings()).bookings);
    } catch (e) {
      if (e instanceof ApiFailure) onError(e);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  const lookup = async () => {
    try {
      setFound((await api.byReference(ref)).booking);
    } catch (e) {
      if (e instanceof ApiFailure) onError(e);
    }
  };

  const doQuote = async (id: string) => setQuote(await api.cancelQuote(id));
  const doCancel = async (id: string) => {
    try {
      await api.cancel(id);
      setQuote(null);
      setFound(null);
      await load();
    } catch (e) {
      if (e instanceof ApiFailure) onError(e);
    }
  };

  const show = found ? [found] : bookings;

  return (
    <>
      <div className="card">
        <h2>Find a booking by reference</h2>
        <p className="small muted">
          Bookings are scoped to your browser session. If the session is gone, the reference is how you get
          back to a booking.
        </p>
        <div className="row">
          <input
            placeholder="CFB-XXXXXX"
            className="mono"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
          <button onClick={lookup}>Look up</button>
          {found && (
            <button className="ghost" onClick={() => setFound(null)}>
              Clear
            </button>
          )}
        </div>
      </div>

      {show.length === 0 && <div className="card muted">No bookings yet.</div>}

      {show.map((b: any) => (
        <div className="card" key={b.id}>
          <div className="offer-head">
            <div>
              <div className="flight">
                {CARRIERS[b.offer.carrier]} {b.offer.segments[0].flightNumber}{' '}
                <span className={`badge ${b.corporateFareApplied ? 'corp' : 'retail'}`}>
                  {b.corporateFareApplied ? 'CORPORATE' : 'RETAIL'}
                </span>
                {b.status === 'CANCELLED' && (
                  <span className="badge retail" style={{ marginLeft: 6 }}>
                    CANCELLED
                  </span>
                )}
              </div>
              <div className="muted small">
                {b.offer.segments[0].origin} → {b.offer.segments[0].destination} ·{' '}
                {new Date(b.offer.segments[0].departsAt).toLocaleDateString('en-IN')} · ref{' '}
                <span className="mono">{b.reference}</span> · PNR <span className="mono">{b.pnr}</span>
              </div>
            </div>
            <div className="price">
              <div className="total">{inr(b.offer.landedCost.totalPayable)}</div>
              <div className="net">ITC {inr(b.offer.landedCost.recoverableItc)}</div>
            </div>
          </div>

          {b.status !== 'CANCELLED' && (
            <div className="row" style={{ marginTop: 12 }}>
              <button onClick={() => doQuote(b.id)}>Quote cancellation</button>
              <button
                className="ghost"
                onClick={async () => {
                  const q = await api.changeQuote(b.id);
                  alert(
                    `Change fee: ${inr(q.changeFee)}\n${q.withinFreeWindow ? '(within the fee-free window)\n' : ''}\n${q.notes.join('\n')}\n\n${q.handoff}`,
                  );
                }}
              >
                Quote change
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  try {
                    await api.nameChange(b.id);
                  } catch (e) {
                    if (e instanceof ApiFailure) alert(e.payload.error);
                  }
                }}
              >
                Change name
              </button>
            </div>
          )}

          {quote?.bookingId === b.id && (
            <div className="banner warn" style={{ marginTop: 12 }}>
              <strong>Cancellation fee {inr(quote.cancellationFee)}</strong> · refund{' '}
              {inr(quote.refundAmount)} · ITC of {inr(quote.itcReversed)} is reversed
              <ul className="small" style={{ margin: '8px 0' }}>
                {quote.notes.map((n: string, i: number) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
              <button className="danger" onClick={() => doCancel(b.id)}>
                Confirm cancellation
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function OpsView() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);

  const load = useCallback(async () => {
    setAlerts((await api.alerts()).alerts);
    setHealth(await api.legHealth());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <div className="card">
        <h2>Corporate fare query health</h2>
        <p className="small muted">
          A corporate query that fails silently looks exactly like "no corporate fare available". This is
          how we tell the difference.
        </p>
        <table>
          <thead>
            <tr>
              <th>Carrier</th>
              <th>Leg</th>
              <th>Outcomes</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {(health?.legs ?? []).map((l: any) => (
              <tr key={`${l.carrier}-${l.fareType}`}>
                <td>{CARRIERS[l.carrier]}</td>
                <td>{l.fareType}</td>
                <td className="small">
                  {Object.entries(l.outcomes)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </td>
                <td>{l.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Alerts ({alerts.length})</h2>
        {alerts.length === 0 && <div className="muted small">Nothing outstanding.</div>}
        {alerts.map((a) => (
          <div className="banner error" key={a.id}>
            <strong>{a.code}</strong>
            <div className="small">{a.message}</div>
            <button
              className="ghost"
              style={{ marginTop: 8 }}
              onClick={async () => {
                await fetch(`/api/admin/alerts/${a.id}/acknowledge`, { method: 'POST' });
                load();
              }}
            >
              Acknowledge
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/** Failure injection, so the Stage 2 behaviours can actually be demonstrated. */
function DevBar({ onReset }: { onReset: () => void }) {
  const call = (payload: any) => api.mock(payload).catch(() => {});
  return (
    <div className="devbar">
      <div className="inner">
        <span className="small muted">demo controls:</span>
        <button onClick={() => call({ action: 'failLeg', carrier: '6E', fareScope: 'CORPORATE', failure: 'AUTH_FAILURE' })}>
          Break IndiGo corporate (auth)
        </button>
        <button onClick={() => call({ action: 'failLeg', carrier: 'AI', fareScope: 'CORPORATE', failure: 'TIMEOUT' })}>
          Hang Air India corporate
        </button>
        <button onClick={() => call({ action: 'priceDelta', delta: 0.08 })}>
          Raise price 8% at booking
        </button>
        <button onClick={() => call({ action: 'dropBookResponse' })}>Lose next booking response</button>
        <button
          className="ghost"
          onClick={() => {
            call({ action: 'reset' });
            onReset();
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
