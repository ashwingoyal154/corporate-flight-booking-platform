# Corporate Flight Booking Platform — Prototype

A corporate flight self-booking tool (SBT) for an India-based consulting firm: **400 consultants,
~200 business trips/month**, mostly domestic. Built to maximise **corporate fare capture** and
**GST input tax credit recovery**.

This repo is a **runnable prototype covering stages 1–4** of [`plan.md`](./plan.md), running against a
**mock supply provider**. It is meant to be clicked through and evaluated early.

| Document | What it is |
|---|---|
| [`research.md`](./research.md) | Market and competitor research. **Partial** — see §0 for what completed |
| [`spec.md`](./spec.md) | Product & engineering specification, requirement IDs, acceptance criteria |
| [`plan.md`](./plan.md) | Six end-to-end delivery stages |

---

## Quick start

```bash
npm install
npm run build         # compiles the server and builds the UI
npm run seed          # writes the seeded organisation config to data/db.json
npm start             # http://localhost:3000
```

For UI development with hot reload, run the API and Vite separately:

```bash
npm run start:dev     # terminal 1 — API on :3000, via tsx, no build step
npm run dev:web       # terminal 2 — UI on :5173, proxies /api to :3000
```

```bash
npm test              # 248 tests
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
8. Open **Reports** — attach rates, realised savings split between fare discount and ITC, and
   corporate query health.
9. Open **Admin** — change a carrier's corporate fare mechanism, then search again and watch it apply.
   Download the GSTR-2B CSV.

### Watch the policy engine work

- Search in **Premium** cabin — every fare is **blocked**, and Select is disabled. Hard rules cannot be
  justified away.
- Search a date **2 days out** — fares breach the advance-purchase rule *softly*: bookable, but
  checkout demands a written justification that is recorded against the booking.
- Pick a **retail** fare where a corporate one exists — a second, separate reason is required, and the
  forgone saving shows up under leakage in Reports.

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

### Stage 3 — spend less

- **Ranking by landed cost, not headline price** — net of recoverable ITC, plus weighted change-fee
  exposure. Every offer shows *why* it ranks where it does; nothing is reordered silently
- **Justification capture** — booking a retail fare when a corporate one existed on the same flight
  requires a recorded reason, and the forgone saving is attributed
- **Savings dashboard** — corporate attach rate, GSTIN attach rate, realised savings split between
  fare discount and ITC, and corporate-query health
- **Credit shell tracking** — cancelled tickets leave value with the carrier; untracked, it expires
- **Both invoices captured** — the airline's fare invoice and our service-fee invoice

### Stage 4 — run it

- **Admin console** — legal entities with positional GSTIN validation, corporate fare configs per
  carrier, cost centres and projects. A new carrier code goes live with no code change and no deploy
- **Policy engine** — fare caps compared against *landed* cost, cabin rules, advance-purchase
  windows, preferred carriers. Soft breaches need a justification; hard breaches are blocked before
  any provider call
- **Mandatory allocation** — project code, cost centre and client-billable flag on every booking,
  validated against config
- **Spend reporting** by project, cost centre and billability
- **GSTR-2B reconciliation export** (CSV) — one line per *invoice*, since 2B is filed per supplier
  invoice; cancelled bookings flagged so finance stops claiming reversed credit

## What is deliberately not here

**Stage 5 (live supply)** is blocked on a commercial decision, not on engineering. The supply partner
(`DEC-1`) is undecided, and every Indian aggregator's API documentation is partner-gated — that needs
an NDA, not more code. Everything sits behind the `SupplyProvider` port so the swap is contained.

**Stage 6 (authentication, approvals, arranger booking)** is deliberately unbuilt because it
contradicts a constraint you set: `CON-10` says no auth for now, with bookings scoped to a session.
Building it would mean overriding that. The data model is already shaped for it — `Booking.ownerRef`
is nullable and waiting, and the audit trail records an actor from day one — so it is a backfill
rather than a rewrite when you want it.

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
    ranking.ts           landed-cost ranking + explanations
  policy/engine.ts       policy evaluation, soft vs hard breaches
  reporting/
    metrics.ts           attach rates, savings, credit shells, leg health
    finance.ts           spend by project, compliance, GSTR-2B ledger
  booking/
    cart.ts              CON-1 enforcement
    hold.ts              5-minute hold
    payment.ts           card-data rejection
    bookingService.ts    idempotency, price-change halt, audit
    servicing.ts         cancel / change quote / name change
  gst/
    gate.ts              GSTIN hard-block, place-of-supply check
    invoices.ts          airline + agent invoice capture
  store/                 JSON-file persistence + seeded config
tests/                   248 tests, organised by requirement ID
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
| `stage3-ranking-nudges.test.ts` | `FR-DISP-3`, `FR-DISP-4` — including that a dearer headline fare correctly ranks first |
| `stage3-reporting.test.ts` | `FR-RPT-1/2/3`, `FR-SVC-3`, `FR-GST-4` |
| `stage4-policy.test.ts` | `FR-POL-2`, `FR-POL-3` — soft vs hard, and no provider call on a block |
| `stage4-finance.test.ts` | `FR-BOOK-1`, `FR-RPT-4`, `FR-RPT-5`, `FR-GST-6` |
| `e2e-journeys.test.ts` | Full journeys over the real HTTP API — every constraint re-proved at the route boundary, not just in services |
| `ui-api-contract.test.ts` | Every endpoint the UI calls is routed; the built bundle is served and contains the screens the demo depends on |
| `admin-gate.test.ts` | The admin surface is token-gated while the booking journey stays public; production refuses to boot without a token |
| `serverless-store.test.ts` | Memory mode never touches the filesystem, still behaves like a store, and file mode still persists |

---

## Testing

248 tests in three layers:

- **Service tests** pin each requirement in isolation (`CON-1`, `FR-GST-1`, `CON-12`, …).
- **End-to-end journeys** drive the real HTTP API through complete flows — search → hold → book →
  retrieve → cancel — and re-prove every constraint at the route boundary. A rule enforced in a
  service but bypassable through a route is not enforced at all.
- **UI ↔ API contract** reads the endpoint list out of `web/src/api.ts` and asserts the server routes
  every one, then checks the built bundle is served and still contains the screens the demo relies on.

The end-to-end layer earned its place immediately by finding a real security defect: a payment token
of the form `tok_4111111111111111` was **accepted**. The card-data scanner used a `\b` word boundary,
and `_` is a word character, so the digits after the underscore never matched. The detector now pulls
out every digit run regardless of boundaries and Luhn-checks each 13–19 digit window; `assertPaymentToken`
scans the token itself, because a token containing a card number is card data whatever it is called.
Both cases are pinned by regression tests.

### Not covered

There is **no browser-level UI test**. The bundle is verified to build, serve, and contain the expected
screens, and every API call it makes is exercised end-to-end — but nobody has automated a click
through the React app. Treat the UI as manually verified.

## Deploying

The app is a single Node process serving both the API and the built UI, so any
container host works. A `Dockerfile` is included, plus blueprints for two hosts.

### The one thing you must set: `ADMIN_TOKEN`

`CON-10` says v1 has no authentication, and for the **booking journey** that is fine — a booking is
scoped to a session and exposes nothing but itself. It is **not** fine for the **admin surface**.
Served openly, any visitor could delete the corporate fare configuration, rewrite travel policy, or
pull the whole GST ledger — and break the app for everyone else.

So mutating admin routes and the demo failure controls require an `x-admin-token` header matching
`ADMIN_TOKEN`. **With `NODE_ENV=production` the server refuses to start without one**, because
forgetting it is a silent and total failure.

| Surface | Public | Needs token |
|---|---|---|
| Search, hold, book, retrieve, cancel | ✅ | — |
| Reports dashboard, leg health | ✅ | — |
| Admin config read/write, policy, projects, entities | — | ✅ |
| Demo failure injection (`/api/mock/control`) | — | ✅ |

Locally, with no `ADMIN_TOKEN` set, the gate stays open so development is frictionless. `/api/health`
reports `adminGated` so the UI knows whether to prompt.

### Vercel (config included)

```bash
npx vercel login
npx vercel --prod
```

Then set the admin token — the deploy will refuse to serve admin routes without it:

```bash
npx vercel env add ADMIN_TOKEN production   # paste: openssl rand -hex 24
npx vercel --prod                           # redeploy so it takes effect
```

Two things about Vercel specifically, because it is serverless rather than a long-lived server:

- **The filesystem is read-only**, so the store runs in **memory mode** (`MEMORY_ONLY` in
  `src/store/store.ts`), seeded lazily on each cold start. State lives as long as the warm instance
  and is not shared between instances — fine for a demo with fabricated data, and precisely what a
  database behind the same `Store` interface would fix.
- The function is a **catch-all route** (`api/[...path].ts`), not a rewrite. A `rewrites` rule
  pointing `/api/(.*)` at one function hands Express the *rewritten* URL, so every route misses and
  everything 404s. The catch-all preserves the original path.

### Render (blueprint included)

Push the repo, then **New → Blueprint** and point it at `render.yaml`. Render generates `ADMIN_TOKEN`
itself — read it from the dashboard to unlock the admin console.

### Fly.io

```bash
fly launch --no-deploy --copy-config
fly secrets set ADMIN_TOKEN="$(openssl rand -hex 24)"
fly deploy
```

`fly.toml` sets the primary region to Mumbai (`bom`) and scales to zero when idle.

### Any Docker host

```bash
docker build -t corporate-flight-booking .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e ADMIN_TOKEN="$(openssl rand -hex 24)" \
  corporate-flight-booking
```

### Data persistence

State lives in `data/db.json`. On an ephemeral container filesystem it resets on every redeploy —
which for a shared demo is a feature, not a bug: each deploy starts from clean seeded data. Mount a
volume at `/app/data` if you want it to survive.

Note that the demo's state is **shared across visitors**: two people using the deployed link see each
other's bookings in Reports. That is acceptable for a demo with fabricated data, and it is exactly
what per-user isolation would fix once authentication lands (Stage 6).

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
