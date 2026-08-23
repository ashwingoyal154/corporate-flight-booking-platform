import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiFailure, api, getAdminToken, inr, setAdminToken, timeOf } from './api.js';

type View = 'search' | 'results' | 'checkout' | 'confirmed' | 'bookings' | 'reports' | 'admin' | 'ops';

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
  const [health, setHealth] = useState<any>(null);
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
        setHealth(await api.health());
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
          <button className={view === 'reports' ? 'active' : ''} onClick={() => setView('reports')}>
            Reports
          </button>
          <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>
            Admin
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
          config={config}
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
      {view === 'reports' && <ReportsView />}
      {view === 'admin' && <AdminView onError={setError} gated={health?.adminGated} />}
      {view === 'ops' && <OpsView />}

      <DevBar onReset={() => setResult(null)} gated={health?.adminGated} />
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
  const [grouped, setGrouped] = useState(false);
  const failedLegs = result.legs.filter(
    (l: any) => l.fareType === 'CORPORATE' && l.outcome !== 'SUCCESS' && l.outcome !== 'NO_INVENTORY',
  );

  // Offers arrive pre-ranked by landed cost including change exposure (FR-DISP-3).
  const ranked = result.offers;
  const corporate = ranked.filter((o: any) => o.fareType === 'CORPORATE');
  const retail = ranked.filter((o: any) => o.fareType === 'RETAIL');

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
        <button className="ghost" style={{ marginLeft: 'auto' }} onClick={() => setGrouped(!grouped)}>
          {grouped ? 'Show ranked' : 'Group by fare type'}
        </button>
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

      {grouped ? (
        <>
          <h2>Corporate fares</h2>
          {corporate.length === 0 && (
            <div className="banner info">No corporate fares were returned for this route.</div>
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
      ) : (
        <>
          <div className="banner info">
            <strong>Ranked by total cost to the company</strong> — fare plus GST, less recoverable input
            tax credit, plus weighted change-fee exposure. This is not the same order as headline price:
            a fare that looks dearer can genuinely cost less.
          </div>
          <div className="grid">
            {ranked.map((o: any, i: number) => (
              <Offer key={o.id} o={o} onSelect={onSelect} rank={i + 1} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Offer({ o, onSelect, rank }: any) {
  const seg = o.segments[0];
  const isCorp = o.fareType === 'CORPORATE';
  const declinesCorporate = !isCorp && o.corporateAlternativeId;

  return (
    <div className={`offer ${isCorp ? 'corporate' : ''}`}>
      <div className="offer-head">
        <div>
          <div className="flight">
            {rank === 1 && (
              <span className="badge save" style={{ marginRight: 8 }}>
                BEST TOTAL COST
              </span>
            )}
            {CARRIERS[o.carrier]} {seg.flightNumber}
            <span className={`badge ${isCorp ? 'corp' : 'retail'}`} style={{ marginLeft: 8 }}>
              {isCorp ? 'CORPORATE FARE' : 'Retail'}
            </span>
            {isCorp && o.savingVsRetail > 0 && (
              <span className="badge save" style={{ marginLeft: 6 }}>
                {inr(o.savingVsRetail)} below retail
              </span>
            )}
            {/* FR-POL-2 — policy verdict is visible at search, not discovered at checkout. */}
            {o.policy && !o.policy.compliant && (
              <span
                className={`badge ${o.policy.blocked ? 'blocked' : 'outpolicy'}`}
                style={{ marginLeft: 6 }}
                title={o.policy.breaches.map((b: any) => b.message).join('\n')}
              >
                {o.policy.blocked ? 'BLOCKED BY POLICY' : 'OUT OF POLICY'}
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

          {/* FR-DISP-3 — never reorder silently; say why this ranks here. */}
          {o.rankingReasons && (
            <ul className="small muted reasons">
              {o.rankingReasons.map((r: string, i: number) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}

          {/* FR-DISP-4 — flag the forgone saving before it is forgone. */}
          {declinesCorporate && (
            <div className="banner warn small" style={{ marginTop: 8, marginBottom: 0 }}>
              A corporate fare is available on this flight, {inr(o.corporateAlternativeSaving)} cheaper.
              Choosing this one needs a reason.
            </div>
          )}
        </div>
        <div className="price">
          <div className="total">{inr(o.landedCost.totalPayable)}</div>
          <div className="itc">incl. {inr(o.price.gstAmount)} GST</div>
          {/* FR-DISP-2: landed cost, not headline fare. */}
          <div className="net">net {inr(o.landedCost.netCost)} after ITC</div>
          <button
            className="primary"
            style={{ marginTop: 8 }}
            onClick={() => onSelect(o.id)}
            disabled={o.policy?.blocked}
            title={o.policy?.blocked ? 'Blocked by travel policy' : undefined}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckoutView({ hold, meta, entity, config, onCancel, onBooked, onError }: any) {
  const [remaining, setRemaining] = useState(meta?.remainingMs ?? 0);
  const [pax, setPax] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });
  const [busy, setBusy] = useState(false);
  const [priceChange, setPriceChange] = useState<{ oldTotal: number; newTotal: number } | null>(null);
  // FR-DISP-4 — required when this retail fare declines an available corporate one.
  const [reason, setReason] = useState('');
  // FR-BOOK-1 — allocation is mandatory.
  const [alloc, setAlloc] = useState({ projectCode: '', costCentreCode: '' });
  // FR-POL-3 — required on a soft policy breach.
  const [policyReason, setPolicyReason] = useState('');
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
        ...(reason.trim() ? { retailOverCorporateReason: reason.trim() } : {}),
        allocation: {
          projectCode: alloc.projectCode,
          costCentreCode: alloc.costCentreCode,
          clientBillable: selectedProject?.clientBillable ?? false,
        },
        ...(policyReason.trim() ? { policyJustification: policyReason.trim() } : {}),
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
  const needsReason = Boolean(o.corporateAlternativeId);
  const projects = config?.projects ?? [];
  const costCentres = config?.costCentres ?? [];
  const selectedProject = projects.find((p: any) => p.code === alloc.projectCode);
  const pol = o.policy;
  const needsPolicyReason = Boolean(pol?.requiresJustification);
  const blocked = Boolean(pol?.blocked);
  const complete =
    pax.firstName &&
    pax.lastName &&
    pax.email &&
    pax.phone &&
    alloc.projectCode &&
    alloc.costCentreCode &&
    (!needsReason || reason.trim().length >= 3) &&
    (!needsPolicyReason || policyReason.trim().length >= 3);

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
          <h3>Allocation</h3>
          <p className="small muted">
            Travel on a client engagement is rebilled, so this is what separates recoverable cost from
            firm overhead.
          </p>
          <div className="row">
            <div>
              <label>Project / engagement</label>
              <select
                value={alloc.projectCode}
                onChange={(e) => setAlloc({ ...alloc, projectCode: e.target.value })}
              >
                <option value="">Select…</option>
                {projects.map((p: any) => (
                  <option key={p.code} value={p.code}>
                    {p.code} — {p.name} ({p.clientName})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Cost centre</label>
              <select
                value={alloc.costCentreCode}
                onChange={(e) => setAlloc({ ...alloc, costCentreCode: e.target.value })}
              >
                <option value="">Select…</option>
                {costCentres.map((c: any) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
            </div>
            {selectedProject && (
              <div>
                <label>Billing</label>
                <div>
                  <span className={`badge ${selectedProject.clientBillable ? 'save' : 'retail'}`}>
                    {selectedProject.clientBillable ? 'CLIENT BILLABLE' : 'FIRM INTERNAL'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {blocked && (
          <div className="card">
            <div className="banner error" style={{ marginBottom: 0 }}>
              <strong>This fare cannot be booked.</strong>
              <ul className="small" style={{ margin: '6px 0 0' }}>
                {pol.breaches.map((b: any, i: number) => (
                  <li key={i}>{b.message}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {needsPolicyReason && (
          <div className="card">
            <h3>Out of policy</h3>
            <div className="banner warn">
              <ul className="small" style={{ margin: 0 }}>
                {pol.breaches.map((b: any, i: number) => (
                  <li key={i}>{b.message}</li>
                ))}
              </ul>
            </div>
            <label>Justification (required)</label>
            <input
              style={{ width: '100%' }}
              placeholder="e.g. client escalation required same-week travel"
              value={policyReason}
              onChange={(e) => setPolicyReason(e.target.value)}
            />
          </div>
        )}

        {needsReason && (
          <div className="card">
            <h3>Why not the corporate fare?</h3>
            <div className="banner warn">
              A corporate fare was available on this flight,{' '}
              <strong>{inr(o.corporateAlternativeSaving)}</strong> cheaper. Booking this retail fare
              forgoes that saving, so the reason is recorded against the booking.
            </div>
            <label>Reason (required)</label>
            <input
              style={{ width: '100%' }}
              placeholder="e.g. corporate fare timing did not fit the client meeting"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}

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
              disabled={busy || expired || !complete || blocked || !!priceChange}
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
function DevBar({ onReset, gated }: { onReset: () => void; gated?: boolean }) {
  const [blocked, setBlocked] = useState(false);
  const call = (payload: any) =>
    api.mock(payload).catch((e) => {
      if (e instanceof ApiFailure && e.status === 401) setBlocked(true);
    });

  if (gated && blocked) {
    return (
      <div className="devbar">
        <div className="inner">
          <span className="small muted">
            Demo failure controls are admin-gated on this deployment — unlock the Admin tab with a token
            to use them.
          </span>
        </div>
      </div>
    );
  }
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

/**
 * Reporting — FR-RPT-1, FR-RPT-2, FR-RPT-3, FR-SVC-3, FR-RPT-6.
 *
 * The numbers here are computed from stored booking evidence, not from vendor
 * marketing percentages. research.md §6.2 found no credible published figure
 * for the real discount on Indian corporate fares, so this view is how the
 * thesis gets tested rather than assumed.
 */
function ReportsView() {
  const [d, setD] = useState<any>(null);

  const load = useCallback(async () => {
    setD(await api.dashboard());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (!d) return <div className="card muted">Loading…</div>;

  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const a = d.attach;
  const sv = d.savings;

  return (
    <>
      {d.headlines.map((h: string, i: number) => (
        <div className={`banner ${h.startsWith('No leakage') ? 'ok' : 'warn'}`} key={i}>
          {h}
        </div>
      ))}

      <div className="stats">
        <Stat
          label="Corporate fare attach rate"
          value={pct(a.corporateAttachRate)}
          sub={`${a.corporateBookings} of ${a.corporateEligibleBookings} where a corporate fare existed`}
        />
        <Stat
          label="GSTIN attach rate"
          value={pct(a.gstinAttachRate)}
          sub={`${a.bookingsWithGstin} of ${a.totalBookings} bookings · target 100%`}
          good={a.gstinAttachRate === 1}
        />
        <Stat
          label="Total saving"
          value={inr(sv.totalSaving)}
          sub={`${sv.savingRatePct === null ? '—' : sv.savingRatePct.toFixed(1) + '%'} of counterfactual retail spend`}
          good
        />
        <Stat
          label="Recoverable ITC"
          value={inr(sv.itcRecoverable)}
          sub="uncorrectable after ticketing"
          good
        />
      </div>

      <div className="card">
        <h2>Where the saving comes from</h2>
        <table>
          <tbody>
            <tr>
              <td>Corporate fare discount realised</td>
              <td className="num">{inr(sv.realisedCorporateSaving)}</td>
            </tr>
            <tr>
              <td>GST input tax credit recoverable</td>
              <td className="num">{inr(sv.itcRecoverable)}</td>
            </tr>
            <tr>
              <td>
                <strong>Total</strong>
              </td>
              <td className="num">
                <strong>{inr(sv.totalSaving)}</strong>
              </td>
            </tr>
            <tr>
              <td className="muted">Total paid ({sv.bookingCount} bookings)</td>
              <td className="num muted">{inr(sv.totalPayable)}</td>
            </tr>
            <tr>
              <td className="muted">Net of ITC</td>
              <td className="num muted">{inr(sv.netCost)}</td>
            </tr>
          </tbody>
        </table>
        <p className="small muted" style={{ marginBottom: 0 }}>
          ITC is typically the larger and more reliable half: it needs no airline contract and applies to
          every booking, whereas the fare discount depends on corporate inventory being available.
        </p>
      </div>

      {a.declinedCorporate > 0 && (
        <div className="card">
          <h2>Leakage — corporate fares declined</h2>
          <p className="small">
            {a.declinedCorporate} booking(s) took a retail fare when a corporate one was available,
            forgoing <strong>{inr(a.forgoneSaving)}</strong>. Reasons are recorded against each booking.
          </p>
        </div>
      )}

      <div className="card">
        <h2>Unused credit shells</h2>
        {d.credits.count === 0 ? (
          <div className="muted small">None held.</div>
        ) : (
          <>
            <p className="small">
              <strong>{inr(d.credits.totalHeld)}</strong> held across {d.credits.count} shell(s).{' '}
              {d.credits.expiringWithin90Days > 0 && (
                <span style={{ color: 'var(--warn)' }}>
                  {d.credits.expiringWithin90Days} expiring within 90 days.
                </span>
              )}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Carrier</th>
                  <th>Shells</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {d.credits.byCarrier.map((c: any) => (
                  <tr key={c.carrier}>
                    <td>{CARRIERS[c.carrier]}</td>
                    <td>{c.count}</td>
                    <td className="num">{inr(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h2>Corporate query health</h2>
        <p className="small muted">
          A corporate query that fails silently looks exactly like "no corporate fare available", and would
          make the attach rate above look better than reality. This is how we tell the difference.
        </p>
        <table>
          <thead>
            <tr>
              <th>Carrier</th>
              <th>Leg</th>
              <th>Success</th>
              <th>Outcomes</th>
            </tr>
          </thead>
          <tbody>
            {d.legs.map((l: any) => (
              <tr key={`${l.carrier}-${l.fareType}`}>
                <td>{CARRIERS[l.carrier]}</td>
                <td>{l.fareType}</td>
                <td style={{ color: l.successRate < 0.99 ? 'var(--bad)' : 'var(--good)' }}>
                  {(l.successRate * 100).toFixed(0)}%
                </td>
                <td className="small">
                  {Object.entries(l.outcomes)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value, sub, good }: any) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={good ? { color: 'var(--good)' } : undefined}>
        {value}
      </div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

/**
 * Admin console — FR-ORG-1, FR-ORG-2, FR-ORG-4, FR-GST-6.
 *
 * The Stage 4 exit criterion: a travel admin adds a carrier's corporate code
 * and it appears in the next search, with no code change and no deploy (CON-7).
 *
 * NOTE (CON-10): there is no auth in v1, so this console is unprotected. It
 * must be role-gated when identity lands in Stage 6.
 */
function AdminView({ onError, gated }: any) {
  const [cfg, setCfg] = useState<any>(null);
  const [tokenInput, setTokenInput] = useState(getAdminToken());
  const [denied, setDenied] = useState(false);
  const [spend, setSpend] = useState<any>(null);
  const [compliance, setCompliance] = useState<any>(null);
  const [draft, setDraft] = useState<any>({
    carrier: 'SG',
    mechanism: 'CONTRACT_CODE',
    credentialRef: '',
    code: '',
    tourCode: '',
  });

  const load = useCallback(async () => {
    try {
      setCfg(await api.adminConfig());
      setSpend(await api.spend());
      setCompliance(await api.compliance());
      setDenied(false);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) setDenied(true);
      else if (e instanceof ApiFailure) onError(e);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  // Deployed publicly, the admin surface is token-gated: without it any visitor
  // could delete the corporate fare configs or rewrite policy for everyone else.
  if (denied || (gated && !cfg)) {
    return (
      <div className="card">
        <h2>Admin access</h2>
        <p className="small muted">
          This deployment is public, so the admin console is gated. The booking journey needs no token;
          this console does, because a visitor could otherwise delete the corporate fare configuration
          for everyone.
        </p>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Admin token</label>
            <input
              type="password"
              style={{ width: '100%' }}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="x-admin-token"
            />
          </div>
          <button
            className="primary"
            onClick={() => {
              setAdminToken(tokenInput.trim());
              load();
            }}
          >
            Unlock
          </button>
        </div>
        {denied && <div className="banner error" style={{ marginTop: 12 }}>That token was rejected.</div>}
      </div>
    );
  }

  if (!cfg) return <div className="card muted">Loading…</div>;

  const saveConfig = async () => {
    try {
      await api.putCorporateConfig(draft.carrier, {
        mechanism: draft.mechanism,
        credentialRef: draft.credentialRef,
        ...(draft.code ? { code: draft.code } : {}),
        ...(draft.tourCode ? { tourCode: draft.tourCode } : {}),
        activeFrom: new Date().toISOString().slice(0, 10),
      });
      await load();
    } catch (e) {
      if (e instanceof ApiFailure) onError(e);
    }
  };

  return (
    <>
      <div className="banner info">
        There is no authentication in this prototype, so this console is unprotected. It must be
        role-gated when identity is added.
      </div>

      <div className="card">
        <h2>Corporate fare configuration</h2>
        <p className="small muted">
          How a corporate fare is unlocked differs by carrier. IndiGo is gated by a separate credential
          and cannot be mixed with retail; full-service carriers use an account code in the request; Akasa
          uses a promo code. The search-time code and the ticket-time tour code are different things — a
          tour code alone unlocks nothing.
        </p>
        <table>
          <thead>
            <tr>
              <th>Carrier</th>
              <th>Mechanism</th>
              <th>Retrieval code</th>
              <th>Tour code</th>
              <th>Credential</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cfg.corporateFareConfigs.map((c: any) => (
              <tr key={c.carrier}>
                <td>{CARRIERS[c.carrier]}</td>
                <td>
                  <span className="badge corp">{c.mechanism}</span>
                </td>
                <td className="mono small">{c.code ?? '—'}</td>
                <td className="mono small">{c.tourCode ?? '—'}</td>
                <td className="mono small muted">{c.credentialRef}</td>
                <td>
                  <button
                    className="ghost"
                    onClick={async () => {
                      await api.deleteCorporateConfig(c.carrier);
                      await load();
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ marginTop: 16 }}>Add or replace</h3>
        <div className="row">
          <div>
            <label>Carrier</label>
            <select value={draft.carrier} onChange={(e) => setDraft({ ...draft, carrier: e.target.value })}>
              {Object.entries(CARRIERS).map(([c, n]) => (
                <option key={c} value={c}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Mechanism</label>
            <select
              value={draft.mechanism}
              onChange={(e) => setDraft({ ...draft, mechanism: e.target.value })}
            >
              <option value="CREDENTIAL">CREDENTIAL</option>
              <option value="ACCOUNT_CODE">ACCOUNT_CODE</option>
              <option value="PROMO_CODE">PROMO_CODE</option>
              <option value="CONTRACT_CODE">CONTRACT_CODE</option>
            </select>
          </div>
          <div>
            <label>Credential reference</label>
            <input
              placeholder="secret://supply/…"
              value={draft.credentialRef}
              onChange={(e) => setDraft({ ...draft, credentialRef: e.target.value })}
            />
          </div>
          <div>
            <label>Retrieval code</label>
            <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          </div>
          <div>
            <label>Tour code</label>
            <input
              value={draft.tourCode}
              onChange={(e) => setDraft({ ...draft, tourCode: e.target.value })}
            />
          </div>
          <button className="primary" onClick={saveConfig}>
            Save
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Legal entities</h2>
        <table>
          <thead>
            <tr>
              <th>Entity</th>
              <th>GSTIN</th>
              <th>State</th>
              <th>Registered name</th>
            </tr>
          </thead>
          <tbody>
            {cfg.legalEntities.map((e: any) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td className="mono">{e.gstin}</td>
                <td>{e.stateCode}</td>
                <td className="small muted">{e.registeredName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Travel policy</h2>
        {cfg.policies.map((p: any) => (
          <div key={p.id}>
            <h3>
              {p.name} {p.isDefault && <span className="badge corp">DEFAULT</span>}
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Enforcement</th>
                  <th>Setting</th>
                </tr>
              </thead>
              <tbody>
                {p.rules.map((r: any, i: number) => (
                  <tr key={i}>
                    <td>{r.kind}</td>
                    <td>
                      <span className={`badge ${r.enforcement === 'HARD' ? 'blocked' : 'outpolicy'}`}>
                        {r.enforcement}
                      </span>
                    </td>
                    <td className="small">
                      {r.kind === 'MAX_FARE' && `${inr(r.amount)}${r.cabin ? ` (${r.cabin})` : ''}`}
                      {r.kind === 'CABIN' && r.allowed.join(', ')}
                      {r.kind === 'ADVANCE_PURCHASE' && `${r.minDays} days`}
                      {r.kind === 'PREFERRED_CARRIER' &&
                        r.carriers.map((c: string) => CARRIERS[c]).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <p className="small muted" style={{ marginBottom: 0 }}>
          Rules are mostly soft by design. Blocking a legitimate late booking pushes people out of the tool,
          and a booking made outside it loses both the corporate fare and the GST credit — more expensive
          than the overspend.
        </p>
      </div>

      {compliance && compliance.total > 0 && (
        <div className="card">
          <h2>Policy compliance</h2>
          <div className="stats">
            <Stat
              label="Compliance rate"
              value={compliance.complianceRate === null ? '—' : `${(compliance.complianceRate * 100).toFixed(0)}%`}
              sub={`${compliance.inPolicy} in policy of ${compliance.total}`}
              good={compliance.complianceRate === 1}
            />
          </div>
          {compliance.justifications.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Justification</th>
                  <th>Breach</th>
                </tr>
              </thead>
              <tbody>
                {compliance.justifications.map((j: any) => (
                  <tr key={j.reference}>
                    <td className="mono small">{j.reference}</td>
                    <td className="small">{j.reason}</td>
                    <td className="small muted">{j.breaches.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {spend && spend.byProject.length > 0 && (
        <div className="card">
          <h2>Spend by project</h2>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Bookings</th>
                <th>Corporate</th>
                <th className="num">Total paid</th>
                <th className="num">Net of ITC</th>
              </tr>
            </thead>
            <tbody>
              {spend.byProject.map((r: any) => (
                <tr key={r.key}>
                  <td>
                    <span className="mono small">{r.key}</span> {r.label}
                  </td>
                  <td>{r.bookings}</td>
                  <td>
                    {r.corporateFareBookings}/{r.bookings}
                  </td>
                  <td className="num">{inr(r.totalPayable)}</td>
                  <td className="num">{inr(r.netCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>GSTR-2B reconciliation</h2>
        <p className="small muted">
          One line per invoice, not per booking — GSTR-2B is filed per supplier invoice, so the airline
          fare and our service fee must match separately. Cancelled bookings are flagged so finance stops
          claiming the reversed credit.
        </p>
        <a href="/api/reports/gstr2b?format=csv">
          <button className="primary">Download CSV</button>
        </a>
      </div>
    </>
  );
}
