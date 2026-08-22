# Corporate Flight Booking Platform — Prototype

A corporate flight self-booking tool (SBT) for an India-based consulting firm: **400 consultants,
~200 business trips/month**, mostly domestic. Built to maximise **corporate fare capture** and
**GST input tax credit recovery**.

This repo is a **runnable prototype covering stages 1 and 2** of [`plan.md`](./plan.md), running
against a **mock supply provider**. It is meant to be clicked through and evaluated early.

| Document | What it is |
|---|---|
| [`research.md`](./research.md) | Market and competitor research. **Partial** — see §0 for what completed |
| [`spec.md`](./spec.md) | Product & engineering specification, requirement IDs, acceptance criteria |
| [`plan.md`](./plan.md) | Six end-to-end delivery stages |

---

## Quick start

```bash
npm install
npm run seed          # writes the seeded organisation config to data/db.json
npm run build:web     # build the UI
npm start             # http://localhost:3000
```

For UI development with hot reload, run the API and Vite separately:

```bash
npm start             # terminal 1 — API on :3000
npm run dev:web       # terminal 2 — UI on :5173, proxies /api to :3000
```

```bash
npm test              # 107 tests
npm run typecheck
```

---

## Try it in five minutes

1. **Search** `DEL → BOM`, two weeks out. Results return in well under 5 seconds.
2. Note the **corporate fares are badged** and show `₹X below retail` — a real like-for-like delta
   against the same flight, not a marketing percentage.
3. Note every price shows **net cost after ITC**, not just the headline fare.
4. **Select a fare** → a **5-minute countdown** starts. GST details are pre-filled and not editable.
5. **Pay** → you get a booking reference like `CFB-9MY4AT`. Write it down.
6. Go to **Bookings**, paste the reference, look it up — it resolves without a session.
7. Hit **Quote cancellation** — the fee shown is the *corporate* fee (₹1,199 on IndiGo), not the
   retail one (₹2,999).

### Then break it on purpose

The demo bar at the bottom of the screen injects failures. This is where stage 2 earns its keep:

| Button | What it proves |
|---|---|
| **Break IndiGo corporate (auth)** | Search again. You get a red banner saying corporate fares *could not be checked* — never "no corporate fare available". Check the **Ops** tab: the failure is classified and alerted |
| **Hang Air India corporate** | Search still returns inside the 5s budget; the hung leg is marked `TIMEOUT` and everything else renders |
| **Raise price 8% at booking** | Checkout halts and shows old → new price. Nothing is charged until you accept |
| **Lose next booking response** | The ticket is issued but the response is lost. Retry — you get the *same* PNR back, never a second ticket |

---

## What is implemented

### Stage 1 — book a corporate flight

- **Dual-search orchestrator** — every carrier is queried twice, in parallel, retail and corporate,
  and merged client-side
- **Corporate/retail never mix in one cart** — rejected at the cart boundary before any provider call
- **5-second hard search budget** with partial results
- **Landed cost display** — fare + GST + recoverable ITC + change/cancel exposure
- **5-minute fare hold** with a visible countdown
- **GSTIN hard-block** — no valid GSTIN, no booking; pre-filled from config, never traveller-typed
- **Tokenised payment** — card data is rejected at the edge, never stored or logged

### Stage 2 — trust it

- **Corporate query outcome classification** (`SUCCESS` / `NO_INVENTORY` / `AUTH_FAILURE` / `TIMEOUT` /
  `MISCONFIGURED` / `PROVIDER_ERROR`) plus admin alerts and a health view
- **Booking reference retrieval** — findable after the session is gone
- **Idempotent booking** — a lost response then five retries yields exactly one ticket
- **Price-change halt** before committing
- **Cancellation with the real corporate fee**, refund and ITC reversal
- **Name change routed to a human** — carrier rules were never established, so we do not guess
- **Immutable audit trail** with correlation IDs

## What is deliberately not here

Stages 3–6 of [`plan.md`](./plan.md): landed-cost *ranking* and nudges, savings dashboards, admin
config UI, policy engine, approvals, live supply, and authentication.

Two constraints shape the prototype and are worth stating plainly:

- **No authentication** (`CON-10`). Bookings are scoped to a browser session; the reference code is
  the way back in. `Booking.ownerRef` is nullable and waiting so auth is a backfill, not a rewrite.
- **Mock supply** (`DEC-1`). The real supply partner is undecided — every Indian aggregator's API
  documentation is partner-gated, so that is a commercial conversation, not a research task.
  Everything sits behind a `SupplyProvider` port so the swap is contained.

---

## Architecture

```
web/                     React UI
src/
  domain/                types, GSTIN validation, money (integer paise), errors
  supply/
    port.ts              SupplyProvider interface  ← the DEC-1 seam
    mock/                MockAdapter + failure injection
  search/
    orchestrator.ts      dual-leg search, 5s budget, leg classification
    pricing.ts           GST + landed cost
  booking/
    cart.ts              CON-1 enforcement
    hold.ts              5-minute hold
    payment.ts           card-data rejection
    bookingService.ts    idempotency, price-change halt, audit
    servicing.ts         cancel / change quote / name change
  gst/gate.ts            GSTIN hard-block, place-of-supply check
  store/                 JSON-file persistence + seeded config
tests/                   107 tests, organised by requirement ID
```

Money is **integer paise** throughout — GST arithmetic feeds an input-tax-credit claim that finance
reconciles against GSTR-2B, and float drift is not acceptable there.

---

## How the tests map to the spec

Each suite is named for the requirement it proves.

| Test file | Covers |
|---|---|
| `con1-mixed-fares.test.ts` | `CON-1`, `FR-SRCH-3` — includes a mutation guard that fails if the check is removed |
| `gst-gate.test.ts` | `FR-GST-1`, `FR-GST-2`, `CON-4`, `CON-5`, GSTIN positional rules, place of supply |
| `card-data.test.ts` | `CON-13`, `NFR-8` — including Luhn-based false-positive resistance |
| `search-budget.test.ts` | `CON-11`, `FR-SRCH-9`, `NFR-2` |
| `search-failure-visibility.test.ts` | `FR-SRCH-4` — a failed corporate query is never reported as absent inventory |
| `hold.test.ts` | `CON-12`, `FR-BOOK-9` |
| `booking-integrity.test.ts` | `FR-BOOK-5`, `FR-BOOK-7`, `NFR-5`, `NFR-3` — includes the chaos retry test |
| `servicing.test.ts` | `FR-SVC-1`, `FR-SVC-2`, `FR-SVC-4`, reference retrieval |
| `landed-cost.test.ts` | `FR-DISP-2`, `FR-GST-5` — asserts the spec's ₹6,000/5% worked example exactly |
| `corporate-proof.test.ts` | `FR-SRCH-5`, `FR-BOOK-6`, `FR-DISP-1` |

---

## Grounding and caveats

Numbers in the mock supply data are drawn from [`research.md`](./research.md), not invented:

- **Corporate discount is modelled at 5–10% off base fare** — the only credible published band found.
  Marketing ceilings of 30% are deliberately *not* modelled; two of them are traps documented in
  research §4.1.
- **Change/cancel fees are per-carrier and real**: IndiGo corporate ~₹499/₹1,199, Air India
  ₹1,300/₹2,300, SpiceJet ₹450, Akasa ₹250 with a fee-free window to T-1h.
- **GST is 5% economy / 18% premium**, held in configuration. These rates are **unverified against a
  primary CBIC notification** (`DEC-6`) and reportedly changed in the 2025 rationalisation — which is
  exactly why they are not hardcoded.

The ITC arithmetic is the load-bearing business claim: recovering GST is worth **~4.8% of all-in
economy cost, ≈₹12 lakh/year** at this client's volume, needs no airline contract, and cannot be fixed
after ticketing. That is why the GSTIN hard-block is stage 1 and not a later refinement.
