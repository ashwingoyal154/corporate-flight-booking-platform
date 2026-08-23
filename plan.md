# Development Plan — Corporate Flight Booking Platform

**Implements:** [`spec.md`](./spec.md) v1.0 · **Grounded in:** [`research.md`](./research.md) v0.2
**Plan version:** 1.0 · **Date:** 2026-08-22

---

## How this plan is structured

**Every stage ships a working product that a real user can complete a real job with.** No stage is a layer,
a foundation, or a set of components waiting for a later stage to make them useful. Stage 1 is a complete
solution to the core problem; each stage after it makes that same solution better, safer, or broader.

The test applied to every stage: *if we stopped here, would the client have something they could use?*
For all six stages the answer is yes.

> **This supersedes the phase table in `spec.md` §11**, which was organised horizontally (foundations →
> core → governance). That ordering would have left the client with nothing usable until phase 3.

### One deliberate exception to "thinnest possible slice"

Stage 1 includes the **full dual-search orchestrator** (`CON-1`: IndiGo corporate and retail fares need
separate credentials and can never be mixed). That is more than a minimal slice needs.

The reason: `CON-1` is *structural*, not additive. Written fresh, a fan-out/merge/tag orchestrator is
marginally more work than a single provider call. Retrofitted onto a single-leg search — after the cart,
pricing, booking and reporting all assume one offer list from one credential — it is a rewrite of the
booking core. **The cost of building it in Stage 1 is small; the cost of deferring it is large.** Everything
else in Stage 1 is genuinely minimal.

### Conventions

| | |
|---|---|
| **Job** | The user problem the stage closes, stated as an outcome |
| **In scope** | Requirement IDs from `spec.md` |
| **Explicitly not yet** | What a reviewer will notice is missing, so the gap is a decision and not an oversight |
| **Demo** | The script to walk through at end of stage — if this runs, the stage is done |
| **Done when** | Objective exit criteria |

---

> ### Build status (2026-08-23)
>
> **Stages 1–4 are built, tested and running** against `MockAdapter` — 181 tests.
>
> **Stage 5 is blocked on `DEC-1`**, a commercial decision rather than an engineering one: every
> Indian aggregator's API documentation is partner-gated, so it needs an NDA before a line of the
> adapter can be written.
>
> **Stage 6 is deliberately unbuilt.** It contradicts `CON-10` (no authentication in v1), which is a
> client constraint, not an oversight. The data model is already shaped for it — `Booking.ownerRef`
> is nullable and the audit trail carries an actor — so it remains a backfill, not a rewrite.

## Stage map

| # | Stage | The job it closes | Gated on |
|---|---|---|---|
| **1** | **Book a corporate flight** | A consultant books a flight on a corporate fare, and finance gets the GST | — |
| **2** | **Trust it** | The booking survives failure, and can be found and changed afterwards | Stage 1 |
| **3** | **Spend less** | The firm can see what it saves, and travellers are steered to the cheaper landed cost | Stage 2 |
| **4** | **Run it** | A travel admin configures policy, entities and fare codes without an engineer | Stage 3 |
| **5** | **Make it real** | Bookings happen on live inventory instead of a mock | `DEC-1`, `DEC-2` |
| **6** | **Scale it to the firm** | People have identities, approvals route, arrangers book for others | `DEC-7`, Stage 5 |

**Stages 1–4 need no external dependency.** They run entirely against `MockAdapter` and can start
immediately, while the supply-partner conversation (`DEC-1`) proceeds in parallel. This is the main
practical payoff of the `SupplyProvider` port.

---

## Stage 1 — Book a corporate flight

> **Job:** *A consultant searches a route, sees that a corporate fare is cheaper than retail, books it, and
> the company's GSTIN is captured so finance can reclaim the input tax credit.*

This is a complete product. Thin, but complete: someone can do the thing the platform exists to do.

### In scope

| Area | Requirements |
|---|---|
| Supply | `CON-6` port + `MockAdapter` returning both retail and corporate offers with realistic Indian domestic data |
| Search | `FR-SRCH-1` dual-leg parallel · `FR-SRCH-2` retail comparator · `FR-SRCH-3` never-mix · `FR-SRCH-5` proof markers · `FR-SRCH-8` one-way + return · `FR-SRCH-9` 5s budget |
| Display | `FR-DISP-1` corporate badge + retail delta · `FR-DISP-2` landed cost with ITC broken out |
| Booking | `FR-BOOK-9` 5-minute hold · `FR-BOOK-10` tokenised payment · `FR-BOOK-11` session-scoped · `FR-BOOK-6` persist credential + fare type + proof |
| GST | `FR-GST-1` hard-block without validated GSTIN · `FR-GST-2` pre-fill from config · `FR-GST-5` rates as config |
| Org | `FR-ORG-1` one legal entity, seeded via config · `FR-ORG-3` credentials as secret refs |
| NFR | `NFR-1` build small · `NFR-2` 5s · `NFR-6` no secrets in logs · `NFR-8` no card data on the server |

### Explicitly not yet

No policy, no approvals, no admin UI (config is a seeded file), no change or cancel, no reporting
dashboard, no multi-city, no international, no arranger booking, no login. A booking that goes wrong is
handled by an engineer looking at the database — **Stage 2 fixes that.**

### Build order within the stage

1. Domain model + `SupplyProvider` port + `MockAdapter` with fixture data
2. Search orchestrator: fan out, race the 5s budget, merge, tag `RETAIL` / `CORPORATE`
3. **Cart boundary enforcing `CON-1`** — write this test before the UI exists
4. Results UI: badge, retail delta, landed cost
5. Hold with a visible 5-minute countdown
6. GST gate — block before any provider call
7. Tokenised payment → book → confirmation
8. Persist `Booking` with proof markers and `session_ref`

### Demo

```
1. Search DEL→BOM, next Tuesday, 1 passenger
2. Results render in under 5s; an IndiGo corporate fare is badged "₹1,240 below retail"
3. Landed cost shows: ₹6,300 payable · ₹300 recoverable ITC · ₹6,000 net
4. Select it — a 5-minute countdown starts
5. Attempt to also add the retail IndiGo fare → rejected, citing CON-1
6. Try to book with the GSTIN blanked → blocked, no provider call made
7. Restore GSTIN, pay with a mock token, book
8. Confirmation shows PNR; the stored booking carries fare_type=CORPORATE and its proof markers
```

### Done when

- The `CON-1` never-mix guarantee has a passing test that fails if the check is removed
- A booking cannot be created without a valid GSTIN, verified by test
- No card PAN appears anywhere in the codebase, logs, or database — verified by a log-scanning test
- Search p95 under 5s against the mock
- The two headline metrics are already computable from stored data: corporate-fare attach rate, GSTIN attach rate

---

## Stage 2 — Trust it

> **Job:** *A booking that hits a network failure doesn't double-ticket or vanish. A traveller whose plans
> changed can find their booking and change it, and knows what the change will cost.*

Stage 1's booking works when everything works. Stage 2 makes it survive reality — which for a consulting
firm, where trips change constantly, is what makes the tool usable rather than a demo.

### In scope

| Area | Requirements |
|---|---|
| Failure visibility | `FR-SRCH-4` corporate query outcomes (`SUCCESS`/`NO_INVENTORY`/`AUTH_FAILURE`/`TIMEOUT`/`MISCONFIGURED`) · `FR-SRCH-7` partial results |
| Booking integrity | `FR-BOOK-5` price-change halt · `FR-BOOK-7` no orphaned PNRs, no double-ticketing · `NFR-5` idempotent under retry |
| Servicing | `FR-SVC-1` view / change / cancel · `FR-SVC-2` real corporate fee shown before committing (`CON-8`) · `FR-SVC-4` name change routed to a human |
| Retrieval | **Booking reference code** — closes the session-scoping hole (`spec.md` §12) |
| Audit | `NFR-3` immutable trail, actor = session ID · `NFR-4` replayable provider calls with correlation IDs |
| Resilience | `NFR-9` graceful degradation |

### The specific problem this stage closes

A silently-failing corporate query is indistinguishable from "no corporate fare on this route." The product
would look healthy while delivering nothing — **the failure mode that quietly destroys the entire thesis.**
`FR-SRCH-4` makes it loud.

Second: `CON-10` scopes bookings to a session, but `FR-SVC-1` lets people service bookings. Without a
retrieval mechanism, a closed browser tab means a booking nobody can reach. A reference code closes it
without needing auth.

### Explicitly not yet

No policy or approvals. No savings dashboard — failures are visible in logs and admin alerts, not charts.
No refund/credit-shell tracking (Stage 3).

### Demo

```
1. Expire the mock's corporate credential → search still returns retail
   → the UI does NOT claim "no corporate fare available"
   → the outcome records AUTH_FAILURE and an admin alert fires
2. Book, note the reference code, close the browser, reopen, retrieve by reference
3. Cancel it → the actual corporate cancellation fee is shown before confirming
4. Kill the connection mid-ticketing, retry → exactly one ticket exists, no orphaned PNR
5. Change the price in the mock between hold and book → booking halts and re-presents the new price
6. Request a name change → routed to a human desk with an explanation
```

### Done when

- Every corporate-query failure mode has a test asserting it never renders as "unavailable"
- A chaos test (kill mid-book, retry ×5) produces exactly one ticket
- Any booking is retrievable by reference after the session ends
- Every provider call is replayable from the audit trail by correlation ID

---

## Stage 3 — Spend less

> **Job:** *The firm can see what it is saving and what it is leaking, and travellers are steered toward the
> lower landed cost rather than the lower headline price.*

Stages 1–2 make corporate fares bookable. Stage 3 makes them **chosen**, and proves the value.

### In scope

| Area | Requirements |
|---|---|
| Ranking & nudges | `FR-DISP-3` rank by landed cost, not headline · `FR-DISP-4` justification when picking retail over an available corporate fare · `FR-DISP-5` fare brands inline · `FR-DISP-6` change/cancel fees at search time |
| Reporting | `FR-RPT-1` corporate-fare attach rate · `FR-RPT-2` GSTIN attach rate · `FR-RPT-3` realised savings vs retail comparator + ITC · `FR-RPT-6` corporate query health |
| Servicing | `FR-SVC-3` refund and credit-shell tracking |
| GST | `FR-GST-4` capture both airline and agent invoices |

### Grounding warning

**`FR-DISP-3` and `FR-DISP-4` are unvalidated hypotheses.** The nudge-benchmark research thread never ran
(`research.md` §0), so there is no evidence for which mechanics actually shift behaviour. Ship them
instrumented and treat Stage 3 as the experiment that tells us. Do not represent the nudge design as
research-backed to the client.

What *is* grounded: ranking by landed cost follows directly from the ITC arithmetic (`research.md` §5.3),
where a ~4.8% ITC recovery legitimately outweighs a smaller headline discount.

### Explicitly not yet

No policy engine, so "out of policy" doesn't exist yet — justification capture is only for
retail-over-corporate. No per-project or per-cost-centre reporting (needs Stage 4 config).

### Demo

```
1. A corporate fare with a higher headline price ranks above a cheaper retail fare
   → the explanation shows why: recoverable ITC and a lower change fee
2. Pick the retail fare anyway → a reason is required and recorded
3. Dashboard: corporate attach rate, GSTIN attach rate (100%), realised savings this month,
   and corporate query failures by carrier and cause
4. Cancel a booking → the credit shell appears in unused-credit reporting
```

### Done when

- Savings per booking are computed from the stored retail comparator, never from a marketing percentage
- The dashboard shows the four metrics in `spec.md` §9 that don't require identity
- Retail-over-corporate selections are queryable with their reasons

---

## Stage 4 — Run it

> **Job:** *A travel admin adds a legal entity, loads a new airline corporate code, and adjusts the policy —
> without an engineer and without a deploy.*

Through Stage 3 the configuration is a seeded file. Stage 4 hands the system to its owners. This is also the
stage that makes `DEC-3` (consolidator-resale vs BYO corporate codes) a config choice rather than a rebuild.

### In scope

| Area | Requirements |
|---|---|
| Admin | `FR-ORG-1` multi-entity CRUD with GSTIN positional validation · `FR-ORG-2` corporate fare config per carrier (`CON-7`) · `FR-ORG-4` cost centres and project codes |
| Booking data | `FR-BOOK-1` mandatory project code, cost centre, client-billable flag |
| Policy | `FR-POL-2` evaluate and label IN/OUT against a **single default policy** · `FR-POL-3` soft vs hard rules with justification |
| GST | `FR-GST-3` place-of-supply mismatch warning · `FR-GST-6` GSTR-2B reconciliation export |
| Reporting | `FR-RPT-4` spend by project, cost centre, billable flag · `FR-RPT-5` policy compliance rate |

### Why policy is only half-built here

`CON-10` (no auth) means there is no traveller grade to evaluate against and no approver to route to.
Stage 4 ships what works without identity: **one default policy, evaluated, labelled, and enforceable soft
or hard.** Grade-based rules (`FR-POL-1`), approval routing (`FR-POL-4`, `FR-POL-5`) and per-client override
(`FR-POL-6`) land in Stage 6. Splitting it this way delivers most of the compliance value years before auth
would otherwise allow.

### Explicitly not yet

No approvals. No per-traveller policy. `CON-7` is BYO-*capable* but nothing is loaded until `DEC-3` resolves.

### Demo

```
1. Admin adds a second legal entity — a GSTIN failing the positional rule is rejected inline
2. Admin adds an Akasa corporate config (promo-code mechanism) → it appears in the next search
3. Book with a Bengaluru entity on a Delhi-origin route → place-of-supply warning fires
4. Book over the default price cap → labelled out-of-policy, justification captured
5. Finance exports the month and reconciles it line-by-line against GSTR-2B
6. Report spend split by project code and client-billable flag
```

### Done when

- A new carrier corporate code goes live with zero code changes and zero deploys
- Every booking carries a project code and cost centre
- The GSTR-2B export reconciles against a full month of test bookings

---

## Stage 5 — Make it real

> **Job:** *The same product, booking real tickets on live inventory.*

Nothing user-facing changes. `MockAdapter` is replaced by the real provider — which is exactly the point of
the port, and the reason Stages 1–4 didn't wait for a commercial negotiation to finish.

### Gated on

**`DEC-1`** (supply partner) and **`DEC-2`** (which airline tier the client qualifies for). Both need
commercial conversations, not engineering. Indian aggregator API docs are partner-gated
(`research.md` §3.5) — **start these conversations at Stage 1, not at Stage 5.**

### In scope

| Area | Requirements |
|---|---|
| Adapter | Real `SupplyProvider` implementation for the `DEC-1` provider |
| Credentials | **Dual IndiGo credentials** — separate Agency IDs/PCCs for corporate and retail (`CON-1`) |
| Retrieval | `FR-SRCH-6` restrict-to-corporate flags (`@AccountCodeFaresOnly`, `FaresIndicator`) |
| GST plumbing | `FR-BOOK-3` GST SSRs in **both** the price and book calls (`CON-5`) — the highest-risk item in the stage |
| Perks | `FR-BOOK-4` corporate traveller SSR (IndiGo `SSR CPTR`) for included bag/meal/seat |
| Codes | `CON-3` account code at search, tour code at ticketing — configured separately |
| Deadlines | `FR-GST-7` airline GST-portal deadline tracking |

### Risks specific to this stage

| Risk | Mitigation |
|---|---|
| GST SSRs missing from one of the two calls → **ITC silently lost, uncorrectable** (`CON-4`) | Contract test asserting both calls carry them; fail the booking if either lacks them |
| The mock's fare semantics differ from the real provider's | Record real provider responses and replay them as mock fixtures before cutover |
| `DEC-2` resolves badly — the client falls between SME and large-corporate tiers | Surfaces as a poor attach rate; the Stage 3 dashboard measures it from day one |
| The provider does not expose corporate fares at all | **This invalidates the thesis, not the build.** Everything except the corporate leg still works. Discover it in the `DEC-1` conversation, not here |

### Demo

```
1. A real DEL→BOM search returns live retail and live corporate fares
2. Book a real corporate fare; the ticket carries the tour code and the GSTIN
3. The airline's GST invoice arrives against the company GSTIN
4. Corporate perks (bag, meal, seat) are present on the ticket
```

### Done when

- A real ticket is issued on a corporate fare with GST correctly attached
- Both provider calls verifiably carry GST SSRs
- Retail and corporate IndiGo searches use different credentials, verified in provider logs

---

## Stage 6 — Scale it to the firm

> **Job:** *People log in as themselves. Managers approve trips. EAs book for consultants. Policy knows who
> you are.*

The governance layer `CON-10` deferred. Everything here was designed for from day one — `Booking.owner_ref`
has been nullable and waiting since Stage 1, so this is a backfill, not a rewrite (`DEC-7`).

### In scope

| Area | Requirements |
|---|---|
| Identity | `FR-ORG-5` SSO + roles from directory groups · `FR-ORG-6` traveller profiles, documents, preferences |
| Migration | `DEC-7` — backfill `owner_ref` on session-scoped bookings |
| Booking | `FR-BOOK-2` arranger / on-behalf-of, with actor and traveller recorded separately |
| Policy | `FR-POL-1` grade and band rules · `FR-POL-6` per-client engagement policy override |
| Approvals | `FR-POL-4` auto-approve in policy, route otherwise · `FR-POL-5` mobile/email approval without login, with SLA and escalation · `FR-POL-7` re-price at approval |
| Audit | `NFR-3` upgraded from session ID to real actor attribution |
| PII | `NFR-7` traveller documents encrypted, access logged — **DPDP Act review required before this stage ships** |

### Explicitly not yet

Hotels, ground transport, rail, duty-of-care tracking, expense-report generation, multi-currency — all out
of scope per `spec.md` §10.

### Demo

```
1. A consultant signs in via SSO; their grade drives the applicable policy
2. An EA books for three consultants in one flow; the audit trail records both actor and travellers
3. An out-of-policy booking routes to the engagement manager, who approves from their phone
4. The fare moved between request and approval → the approver sees the new price before committing
5. A Stage-1 session booking still appears, now owned by the right user
```

### Done when

- No booking path remains that bypasses policy evaluation
- Historical session bookings are migrated with no orphans
- A DPDP compliance review is signed off

---

## Cross-cutting: what gets built once, in Stage 1, and never rebuilt

These are the decisions that are cheap now and expensive later. Every one is in Stage 1 for that reason:

| Decision | Why it can't wait |
|---|---|
| `SupplyProvider` port | Stages 1–4 run on a mock; without the port they'd block on `DEC-1` |
| Dual-search orchestrator | `CON-1` is structural; retrofitting rewrites the booking core |
| `Booking.owner_ref` nullable | Makes Stage 6 a backfill instead of a schema migration |
| Audit trail with an actor field | Populated with session ID from day one so records stay comparable across the auth boundary |
| GST rates as configuration | `DEC-6` is unresolved and rates changed in 2025 (`research.md` §5.1) |
| Corporate fare identity as config | `DEC-3` may flip from resale to BYO; `CON-7` makes that a config change |
| No card data on the server | Retrofitting PCI scope-reduction is far harder than never acquiring the scope |

---

## Parallel track: unblock Stage 5 while Stages 1–4 build

Engineering does not gate on this, but Stage 5 does. **Start at Stage 1.**

| Action | Resolves | Notes |
|---|---|---|
| Contact Tripjack / TBO / Verteil for partner API access | `DEC-1` | Docs are partner-gated — this needs an NDA, not a search |
| Parse the Travelport IndiGo 6E implementation guide PDF | `DEC-1` | Already downloaded, never read. Highest-value unread document (`research.md` §3.4) |
| Ask IndiGo and Air India which tier a 400-consultant firm qualifies for | `DEC-2` | The commercial-viability question |
| Confirm GST rates against a primary CBIC notification | `DEC-6` | The ITC business case rests on it |
| Confirm merchant of record and IATA licence position | `DEC-4` | Determines settlement and refund custody |
| Confirm the payment model | `DEC-5` | Shapes Stage 4 reconciliation |
| Get the client's current travel policy document | Stage 4, Stage 6 | Most of the policy epic is `[A]`-grounded guesswork until this lands |
| Ask how trips are booked today — self-serve or via an EA | Stage 6 | Decides how much Stage 6 arranger work matters |

---

## What this plan does not de-risk

Stated plainly, so nobody is surprised later:

1. **The corporate-fare thesis is unproven.** No credible published figure exists for the average realised
   discount of an Indian airline corporate fare versus that airline's own retail fare — the only defensible
   band is ITILITE's 5–10% off published (`research.md` §6.2). `DEC-2` could reveal the client is too small
   to earn a meaningful one. **Stage 3's dashboard is what turns this from an assumption into a measurement**,
   which is a further reason not to defer reporting.
2. **The ITC lever is the more reliable half of the value** — ~4.8% of all-in economy spend, ≈₹12 lakh/year,
   needing no airline contract (`research.md` §5.3). It lands in **Stage 1**. If the corporate-fare thesis
   disappoints, the product still pays for itself, and that is deliberate sequencing.
3. **The policy and approvals epics rest on assumption, not research** (`spec.md` §12). Stages 4 and 6 will
   need rework if the client's actual policy differs from the standard patterns encoded here.
4. **Nudge mechanics are untested** (Stage 3). We are shipping an experiment with instrumentation, not a
   researched design.
