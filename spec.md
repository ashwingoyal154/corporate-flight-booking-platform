# Corporate Flight Booking Platform — Product & Engineering Specification

**Client:** consulting firm — 400 consultants, ~200 business trips/month, India-domestic-dominant
**Product:** corporate self-booking tool (SBT). We build search/booking UX, policy, approvals, reporting.
Flight inventory comes from an external supply partner.
**Primary objective:** minimise **landed cost per trip** — corporate fare + guaranteed GST input-tax-credit
capture + policy compliance.
**Spec version:** 1.0 · **Date:** 2026-08-22 · **Source:** [`research.md`](./research.md) v0.2

---

## 1. How to use this spec

This is written for **spec-driven development**: every requirement is individually addressable, testable,
and traceable back to evidence.

**Conventions**

| Convention | Meaning |
|---|---|
| `FR-<EPIC>-<n>` | Functional requirement |
| `NFR-<n>` | Non-functional requirement |
| `CON-<n>` | Hard constraint — a fact about the world we must design around, not a choice |
| `DEC-<n>` | Open decision that blocks or reshapes work |
| **[G]** | **Grounded** — traceable to a cited source in `research.md` |
| **[A]** | **Assumed** — standard SBT practice, *not* researched. Validate with the client before building |
| **P0 / P1 / P2** | Launch-blocking / first iteration after launch / later |

**Rule for implementers:** a `[G]` requirement may be implemented as written. A `[A]` requirement must be
confirmed with the client or validated by research before it is built — §12 tracks these.

> ### ⚠️ Grounding warning
> `research.md` completed **one of five** planned research threads. The competitor teardown, nudge-pattern
> benchmark, supply-landscape and personas threads were all stopped. Consequently:
> - **Epics E2, E5, E6 (search, booking, GST) are well-grounded** — they rest on primary vendor documentation.
> - **Epics E4, E7, E8 (policy, approvals, servicing, reporting) are largely `[A]`** — they encode standard
>   SBT patterns, not researched requirements.
> Do not read uniform confidence into a uniform-looking document.

---

## 2. Blocking decisions

These gate or reshape the build. **DEC-1 is the critical path.**

| ID | Decision | Why it blocks | Owner | Default if unresolved |
|---|---|---|---|---|
| **DEC-1** | **Which supply partner?** Travelport direct vs Indian aggregator (Tripjack / TBO / Verteil) | Determines whether corporate fares are reachable at all, and the entire adapter implementation. Aggregator API docs are **partner-gated — this needs a commercial conversation, not more searching** ([research §3.5](./research.md)) | Commercial | Build against the adapter port (`CON-6`) with a **mock supply provider**; defer the real integration |
| **DEC-2** | **Does the client qualify for SME or large-corporate airline tiers?** IndiGo and Air India both run two tracks; ~400 staff may fall between them ([research §4.2](./research.md)) | Determines the actual discount, and therefore whether the corporate-fare thesis holds economically | Client + airline sales | Assume SME self-serve enrollment |
| **DEC-3** | **Consolidator-resale or BYO corporate codes?** ([research §6.1](./research.md)) | Changes the config model: our codes vs client-owned codes per carrier | Product | **Build BYO-capable config, launch on whatever supply gives us.** `CON-7` makes this cheap |
| **DEC-4** | **Do we hold an IATA licence / who is merchant of record?** | Determines settlement, PCI scope, refund custody | Legal/Finance | Assume the supply partner is merchant of record; we never touch card PANs |
| **DEC-5** | **Payment model** — central corporate lodged card, prepaid wallet, or credit line | Shapes checkout and reconciliation | Finance | Assume **central lodged card / corporate account**, no traveller-paid bookings. Tokenised regardless (`CON-13`) |
| **DEC-6** | Confirm GST rates (5% economy / 18% premium) against a primary CBIC notification ([research §5.1](./research.md)) | The ITC business case rests on it | Finance/tax | Use 5% / 18%, display as configurable, never hardcode |

---

### 2.1 v1 posture — what `CON-10` and `CON-13` imply

Taken together, the no-auth and card-token constraints define v1 as a **working prototype against a mock
supply provider**, not the production system. That is a coherent posture and the spec supports it — but the
dependency chain must be explicit, because **identity is load-bearing for a third of this document**:

| Capability | Needs identity? | v1 status |
|---|---|---|
| Search, corporate-fare retrieval, dual-search (`E2`) | No | **Full scope** |
| Fare display, landed cost, nudges (`E3`) | No | **Full scope** |
| Fare hold, booking, GST capture (`E5`, `E6`) | No | **Full scope** — GST comes from org config, not from a user |
| Reporting on attach rates (`E8`) | No | **Full scope** — aggregate, not per-traveller |
| Policy evaluation *by traveller grade* (`FR-POL-1`) | **Yes** | **Degraded** — v1 evaluates against a single default policy |
| Approvals routing (`FR-POL-4`, `FR-POL-5`) | **Yes** | **Deferred** — there is no approver to route to |
| Arranger / on-behalf-of booking (`FR-BOOK-2`) | **Yes** | **Deferred** |
| Traveller profiles, per-user history (`FR-ORG-6`) | **Yes** | **Deferred** |
| Audit trail actor attribution (`NFR-3`) | **Yes** | **Degraded** — records session ID, not a person |

**This does not weaken the core thesis.** The highest-value requirements — the `CON-1` dual-search guarantee,
corporate-fare proof capture, and the GSTIN hard-block worth ~₹12 lakh/year — are all identity-independent
and stay in v1 at full scope. What defers is governance, which is the part that was `[A]`-grounded anyway.

**When auth arrives**, `DEC-7` below governs the migration.

| ID | Decision | Why it matters |
|---|---|---|
| **DEC-7** | When auth is introduced, how do session-scoped bookings migrate to user-owned bookings? | Design the `Booking` record with a nullable `owner_ref` from day one so this is a backfill, not a schema rewrite |

---

## 3. Personas & roles

**[A] — the personas thread never reported. Validate before building role-specific UX.**

> **`CON-10`:** v1 implements **none of these roles**. Every user is an anonymous session with full
> capability. The table below is the target model that auth will introduce; it is documented now so the
> data model does not have to be rewritten later.

| Role | Who | Primary needs |
|---|---|---|
| **Traveller** | Consultant | Book own trip in <3 min, on a known route, often last-minute; change it when the client moves the meeting |
| **Arranger** | EA / project admin | Book *on behalf of* one or many travellers. **Assume this is heavily used — consulting firms typically book centrally** |
| **Approver** | Engagement manager / partner | Approve out-of-policy or over-threshold requests fast, from a phone, without logging in |
| **Travel admin** | Ops / admin | Configure policy, manage corporate codes and GSTINs, resolve failed bookings |
| **Finance** | Finance team | GST ITC recovery, cost-centre and project-code allocation, reconciliation, savings reporting |

---

## 4. Hard constraints

Facts about the world, from `research.md`. **Not negotiable, not design choices.**

| ID | Constraint | Source |
|---|---|---|
| **CON-1** | **IndiGo corporate and retail fares require separate Agency IDs/PCCs and cannot be combined.** Mixing raises warning `701422` and the booking fails | [research §1](./research.md) **[G]** |
| **CON-2** | **Corporate fares never appear in a normal search response** on any carrier. Retrieval always requires a distinct credential, account code, promo code, or authenticated portal session | [research §1](./research.md) **[G]** |
| **CON-3** | **The account code (search-time retrieval) and the tour code (ticket-time documentation) are different things**, configured in different places | [research §2](./research.md) **[G]** |
| **CON-4** | **GSTIN cannot be added or corrected after booking.** *"Post-book GST modifications aren't supported."* A wrong legal name requires re-booking the ticket | [research §5.2](./research.md) **[G]** |
| **CON-5** | **GST SSRs must be present in both the price call and the book call** (`SSR GSTN`, `SSR GSTE`). GSTIN is 15 alphanumeric chars with positional rules | [research §3.4](./research.md) **[G]** |
| **CON-6** | **Supply partner is undecided (DEC-1).** All supply access must sit behind a provider-agnostic port | [research §3.6](./research.md) **[G]** |
| **CON-7** | **Corporate fare identity must be configuration, not code** — per carrier, per credential, per code type — because both the supply partner and the sourcing model may change | [research §6.1](./research.md) **[G]** |
| **CON-8** | **Corporate fares carry reduced, not waived, change/cancel fees** — and the fees differ materially by carrier (Akasa ≈ ₹250 and fee-free to T-1h; IndiGo ₹999–1,499; AI ₹1,300–2,300; SpiceJet ₹450) | [research §4](./research.md) **[G]** |
| **CON-9** | **Scale is small: ~10 bookings/business day.** Correctness, auditability and recoverability dominate; throughput is a non-problem. **Do not build for scale we do not have** | **[D]** |
| **CON-10** | **v1 has no authentication.** There are no user accounts, no login, no roles. **A booking is scoped to a browser session** and is addressable only for the life of that session | Client, 2026-08-22 |
| **CON-11** | **Search must return results in under 5 seconds.** Hard budget, not a target (`NFR-2`) | Client, 2026-08-22 |
| **CON-12** | **A selected fare is held for 5 minutes.** After that the hold lapses and the fare must be re-priced (`FR-BOOK-9`) | Client, 2026-08-22 |
| **CON-13** | **Card data must never reach our server.** Payment uses tokens issued by the provider; we store and transmit tokens only, never PAN, CVV or expiry (`FR-BOOK-10`) | Client, 2026-08-22 |

---

## 5. Domain model

Core entities. Field lists are indicative, not exhaustive.

```
Organisation
  ├─ legal_entities[]        # GSTIN is per legal entity per state — not per org
  │    ├─ gstin              # 15 chars, positional validation (CON-5)
  │    ├─ registered_name    # exact GST-portal name; mismatch ⇒ rebook (CON-4)
  │    └─ state_code         # drives CGST+SGST vs IGST
  ├─ cost_centres[]
  ├─ projects[]              # project/engagement code, client_billable flag
  ├─ policies[]
  └─ corporate_fare_configs[]   # CON-7
       ├─ carrier            # 6E / AI / QP / SG
       ├─ mechanism          # CREDENTIAL | ACCOUNT_CODE | PROMO_CODE | CONTRACT_CODE
       ├─ credential_ref     # secret ref — never the secret itself
       ├─ code               # account/promo/contract code where applicable
       ├─ tour_code          # ticket-time documentation, separate from above (CON-3)
       └─ active_from / active_to

Session                            # v1 identity substitute (CON-10)
  ├─ session_id                    # opaque, cookie-bound
  ├─ legal_entity_ref              # which entity this session books against
  ├─ expires_at
  └─ bookings[]                    # scoped here in v1; migrates to owner_ref under DEC-7

Traveller ──> User (role: TRAVELLER | ARRANGER | APPROVER | ADMIN | FINANCE)   # DEFERRED - CON-10
  ├─ legal_entity_ref
  ├─ grade / band            # drives policy entitlement
  ├─ travel_documents        # PII — see NFR-7
  └─ preferences             # seat, meal, frequent flyer

TripRequest
  ├─ requester / traveller(s)     # differ when an arranger books
  ├─ project_ref, cost_centre_ref, client_billable
  ├─ itinerary_intent
  └─ status: DRAFT → PENDING_APPROVAL → APPROVED → BOOKED | REJECTED | EXPIRED

FareOffer                          # ephemeral, from a search
  ├─ carrier, segments, fare_brand
  ├─ fare_type: RETAIL | CORPORATE
  ├─ corporate_proof{}             # @PrivateFare, @NegotiatedFare, PseudoCityCode (FR-SRCH-5)
  ├─ price{ base, taxes, gst_amount, gst_rate, total }
  ├─ landed_cost{}                 # FR-DISP-2
  ├─ change_fee, cancel_fee        # CON-8
  └─ policy_evaluation{}           # FR-POL-2

FareHold                           # CON-12
  ├─ fare_offer_ref, session_ref
  ├─ held_at, expires_at           # expires_at = held_at + 5 min
  └─ status: HELD | CONSUMED | EXPIRED

Booking
  ├─ session_ref                   # v1 owner (CON-10)
  ├─ owner_ref                     # nullable; populated when auth lands (DEC-7)
  ├─ payment_token                 # provider-issued token only, never card data (CON-13)
  ├─ pnr, ticket_numbers, supply_provider, credential_used
  ├─ fare_offer_snapshot           # immutable record of what was sold
  ├─ gst_submission{ gstin, legal_name, email, state_code, submitted_at }
  ├─ corporate_fare_applied: bool + proof
  ├─ status: HELD → TICKETED → CHANGED | CANCELLED | REFUNDED
  └─ audit_trail[]

SavingsRecord                      # per booking, for FR-RPT-1
  ├─ retail_comparator             # from the parallel retail search (FR-SRCH-2)
  ├─ corporate_delta
  ├─ itc_recoverable
  └─ policy_compliant: bool
```

---

## 6. Architecture

### 6.1 The dual-search core

`CON-1` and `CON-2` make this the defining piece of the system. It is not an optimisation — it is the shape
of the product.

```
                        ┌──────────────────────────────┐
   Search request  ───▶ │      Search Orchestrator      │
                        └───────────┬──────────────────┘
                                    │  fan out, in parallel
                    ┌───────────────┴────────────────┐
                    ▼                                ▼
        ┌───────────────────────┐        ┌───────────────────────┐
        │  RETAIL query         │        │  CORPORATE query      │
        │  default credential   │        │  corporate credential │
        │                       │        │  + account/promo code │
        │                       │        │  + AccountCodeFaresOnly│
        └───────────┬───────────┘        └───────────┬───────────┘
                    │                                │
                    └──────────────┬─────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │  Merge · tag · never mix      │
                    │  in one cart (CON-1)          │
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │  Policy evaluation + ranking  │
                    └──────────────────────────────┘
```

**Design notes**
- The corporate leg **can fail silently** and look identical to "no corporate fare today". `FR-SRCH-4`
  exists precisely to make that impossible to miss.
- The retail leg is not just a fallback — it is the **comparator that makes savings reporting and the
  traveller-facing nudge possible** (`FR-DISP-1`, `FR-RPT-1`).
- The merge is a client-side join of two independent responses, with the attendant latency and consistency
  problems. Budget for partial results (`NFR-2`).

### 6.2 Supply adapter port

`CON-6` — the supply partner is undecided, so every provider detail sits behind one interface:

```
SupplyProvider (port)
  search(criteria, credential, fare_scope) -> FareOffer[]
  price(offer, gst_details)                -> PricedOffer      # GST SSRs here (CON-5)
  book(pricedOffer, travellers, gst_details) -> Booking        # and here (CON-5)
  cancel(booking) / change(booking, newItinerary)
  fareRules(offer)

Implementations: TravelportAdapter | TripjackAdapter | TBOAdapter | MockAdapter
```

**Build `MockAdapter` first.** It unblocks every other epic while DEC-1 is open, and it is the only way to
write deterministic tests for `CON-1` behaviour.

---

## 7. Functional requirements

### E1 — Organisation, identity & configuration

| ID | Requirement | Pri | G/A |
|---|---|---|---|
| **FR-ORG-1** | Admins configure legal entities with GSTIN, exact registered name, and state code. GSTIN validated against the 15-char positional rule at entry time | P0 | **[G]** |
| **FR-ORG-2** | Admins configure `corporate_fare_config` per carrier: mechanism, credential reference, code, tour code, validity window (`CON-7`) | P0 | **[G]** |
| **FR-ORG-3** | Credentials are stored as references to a secret manager. Secrets never appear in the database, logs, API responses, or the UI | P0 | **[G]** |
| **FR-ORG-4** | Admins manage cost centres and project codes, each flagged client-billable or not | P0 | **[A]** |
| **FR-ORG-5** | ~~SSO via the client's IdP; roles from directory groups~~ — **deferred, v1 has no authentication (`CON-10`)**. Sessions are anonymous and unprivileged-by-default | P2 | **[G]** |
| **FR-ORG-6** | Traveller profiles hold grade/band, travel documents, seat/meal preferences, frequent-flyer numbers — **deferred, requires identity (`CON-10`)**. v1 collects passenger details per booking instead | P2 | **[A]** |

**Acceptance — FR-ORG-1**
```gherkin
Given an admin is adding a legal entity
When they enter a GSTIN failing the positional rule (1-2 numeric, 3-7 alpha, 8-11 numeric, 12 alpha, 13-15 alnum)
Then the form rejects it inline and the entity is not saved

Given a legal entity exists with a registered name
When that name differs from the GST portal record
Then the system cannot detect it automatically
And the field carries a persistent warning that a mismatch requires re-booking the ticket, not correction
```

### E2 — Search & corporate fare retrieval

**The core epic. Best-grounded in the research.**

| ID | Requirement | Pri | G/A |
|---|---|---|---|
| **FR-SRCH-1** | Every search issues **parallel retail and corporate queries** per carrier, using the configured mechanism for each (`CON-2`) | P0 | **[G]** |
| **FR-SRCH-2** | Retail results are always retrieved, even when a corporate fare exists — they are the savings comparator | P0 | **[G]** |
| **FR-SRCH-3** | Corporate and retail offers for the same carrier are **never combinable in one cart or PNR** (`CON-1`). Enforced at the cart boundary, not only in the UI | P0 | **[G]** |
| **FR-SRCH-4** | Every corporate query's outcome is recorded as `SUCCESS` / `NO_INVENTORY` / `AUTH_FAILURE` / `TIMEOUT` / `MISCONFIGURED`. **A failure must never render as "no corporate fare available"** | P0 | **[G]** |
| **FR-SRCH-5** | Where the provider exposes them, persist private-fare proof markers (`@PrivateFare`, `@NegotiatedFare`, `FareInfo@PseudoCityCode`) on the offer and on the resulting booking | P0 | **[G]** |
| **FR-SRCH-6** | Where the provider supports it, corporate queries set the restrict-to-corporate flag (Travelport: `@AccountCodeFaresOnly="true"`, `FaresIndicator=PrivateFaresOnly`) | P0 | **[G]** |
| **FR-SRCH-7** | Partial results render: if the corporate leg is slow or fails, retail renders with an explicit indicator rather than blocking (`NFR-2`) | P0 | **[G]** |
| **FR-SRCH-8** | Search supports one-way, return, and multi-city; single and multi-traveller | P0 | **[A]** |
| **FR-SRCH-9** | The orchestrator enforces a **5-second wall-clock budget** (`CON-11`). Each provider leg gets a timeout strictly inside it; at the deadline whatever has resolved is returned and unresolved legs are recorded per `FR-SRCH-4` | P0 | **[G]** |

**Acceptance — FR-SRCH-3 (the `CON-1` guarantee)**
```gherkin
Given a search returned both a corporate and a retail IndiGo offer
When a user attempts to add both to a single cart
Then the operation is rejected before any provider call is made
And the rejection is logged with the constraint reference CON-1

Given a cart holds an IndiGo corporate offer
When the booking is submitted
Then every IndiGo segment in that PNR was retrieved with the corporate credential
```

**Acceptance — FR-SRCH-4 (silent-failure prevention)**
```gherkin
Given the corporate credential for IndiGo is expired
When a traveller searches a route IndiGo serves
Then results show retail offers only
And the corporate query outcome records AUTH_FAILURE
And an alert is raised to travel admins
And the traveller is NOT told "no corporate fare is available on this route"
```

**Acceptance — FR-SRCH-9 (`CON-11`)**
```gherkin
Given a search is issued
When the corporate leg has not resolved 5 seconds after the request started
Then whatever results have resolved are returned to the client
And the corporate leg's outcome is recorded as TIMEOUT per FR-SRCH-4
And total wall-clock time to first rendered result is under 5 seconds

Given both legs resolve in 900ms
Then results render immediately and no artificial delay is introduced
```

### E3 — Fare presentation & corporate-fare nudging

> **Grounding note:** the nudge-pattern benchmark thread never ran. `FR-DISP-3` and `FR-DISP-4` encode
> reasonable design instinct, **not** researched or validated mechanics. Treat them as v1 hypotheses with
> instrumentation attached, and revisit once §8/Tier-2 research is done.

| ID | Requirement | Pri | G/A |
|---|---|---|---|
| **FR-DISP-1** | Corporate offers are **badged** and show the delta versus the retail comparator ("₹1,240 below retail") | P0 | **[G]** |
| **FR-DISP-2** | Results display **landed cost**, not headline fare: base + taxes + GST, **recoverable ITC shown separately**, plus change/cancel fee exposure (`CON-8`) | P0 | **[G]** |
| **FR-DISP-3** | Default ranking optimises landed cost, not headline price. A corporate fare with a worse headline may correctly rank above a cheaper retail fare | P0 | **[A]** |
| **FR-DISP-4** | Selecting a retail fare when a corporate fare exists on the same route requires an explicit, logged reason | P1 | **[A]** |
| **FR-DISP-5** | Fare-brand differences (Stretch / Super 6E / Flexi) and what is included (seat, meal, bag) are shown inline, not in fine print | P1 | **[G]** |
| **FR-DISP-6** | Change/cancel fees are surfaced **at search time**, not at checkout — they differ materially by carrier and consulting trips change often | P0 | **[G]** |

**Acceptance — FR-DISP-2**
```gherkin
Given a domestic economy offer with base fare ₹6,000 and GST at 5%
When it renders in results
Then total payable shows ₹6,300
And recoverable ITC shows ₹300
And effective net cost shows ₹6,000
And the GST rate is read from configuration, never hardcoded
```

### E4 — Policy & approvals

**Almost entirely `[A]`.** The requirements thread never reported; this encodes standard SBT patterns.
**Validate the whole epic with the client before building.**

> **`CON-10` gates most of this epic.** Without identity there is no traveller grade to evaluate against and
> no approver to route to. **v1 scope is `FR-POL-2` and `FR-POL-3` only, against a single default policy.**
> `FR-POL-1`, `FR-POL-4`, `FR-POL-5` and `FR-POL-6` all defer to the auth milestone.

| ID | Requirement | Pri | G/A |
|---|---|---|---|
| **FR-POL-1** | Policies are defined by traveller grade/band, route type (domestic/international), cabin, advance-purchase window, and price cap | P0 | **[A]** |
| **FR-POL-2** | Every offer is evaluated against policy at search time and labelled IN / OUT of policy, with the specific breached rule named | P0 | **[A]** |
| **FR-POL-3** | Soft policy: out-of-policy offers are bookable with a captured justification. Hard policy: blocked outright. Configurable per rule | P0 | **[A]** |
| **FR-POL-4** | In-policy trips auto-approve. Out-of-policy or over-threshold trips route to an approver | P0 | **[A]** |
| **FR-POL-5** | Approvers act from email/mobile without a full login; approval SLA and escalation configurable | P1 | **[A]** |
| **FR-POL-6** | **Per-client policy override** — where a consulting engagement's client imposes its own travel rules, the project's policy supersedes the firm's | P1 | **[A]** |
| **FR-POL-7** | Fare price is re-validated at approval; if it moved, the approver sees the new price before committing | P0 | **[G]** |

### E5 — Booking, ticketing & payment

| ID | Requirement | Pri | G/A |
|---|---|---|---|
| **FR-BOOK-1** | Booking captures project code, cost centre and client-billable flag as **mandatory** fields | P0 | **[A]** |
| **FR-BOOK-2** | Arrangers book on behalf of one or many travellers; the acting user and the traveller are recorded separately in the audit trail — **deferred, requires identity (`CON-10`)**. v1 records the session as actor and passenger details per booking | P2 | **[A]** |
| **FR-BOOK-3** | GST details are injected into **both** the price call and the book call (`CON-5`) | P0 | **[G]** |
| **FR-BOOK-4** | Where the carrier supports it, the corporate-traveller SSR is sent (IndiGo `SSR CPTR`) to unlock included bag/meal/seat | P1 | **[G]** |
| **FR-BOOK-5** | Price change between selection and ticketing halts the booking and re-presents the new price for explicit confirmation | P0 | **[G]** |
| **FR-BOOK-6** | Every booking persists the credential used, provider, fare type, and corporate proof markers | P0 | **[G]** |
| **FR-BOOK-7** | Booking failures are recoverable: no orphaned PNRs, no double-ticketing. Every partial failure is reconciled and surfaced to admins | P0 | **[G]** |
| **FR-BOOK-8** | Payment via the central corporate account (`DEC-5`) | P0 | **[A]** |
| **FR-BOOK-9** | Selecting a fare creates a **5-minute hold** (`CON-12`). Remaining time is visible to the user. On expiry the hold lapses, the fare is re-priced, and any price change goes through `FR-BOOK-5` | P0 | **[G]** |
| **FR-BOOK-10** | **Card data must never reach our server (`CON-13`).** The client obtains a token directly from the provider; our server accepts, stores and transmits **only that token**. PAN, CVV and expiry must never appear in a request body, log, database column, or error trace | P0 | **[G]** |
| **FR-BOOK-11** | Bookings are **scoped to the session** that created them (`CON-10`). A session may retrieve and service only its own bookings; the `Booking.owner_ref` field is reserved for `DEC-7` | P0 | **[G]** |

**Acceptance — FR-BOOK-3 (`CON-5`)**
```gherkin
Given a booking for a legal entity with a valid GSTIN
When the provider is called
Then the price request carries the GST fields
And the book request carries the same GST fields
And if either omits them the booking is aborted before ticketing
```

**Acceptance — FR-BOOK-9 (`CON-12`)**
```gherkin
Given a user selects a fare offer
When the hold is created
Then it expires exactly 5 minutes later
And the remaining time is visible to the user throughout checkout

Given a hold has expired
When the user submits the booking
Then the booking is not sent to the provider with the stale price
And the fare is re-priced
And if the price changed the user must explicitly confirm the new price (FR-BOOK-5)
```

**Acceptance — FR-BOOK-10 (`CON-13`)**
```gherkin
Given a user is paying for a booking
When card details are entered
Then they are sent from the browser directly to the provider
And our server receives only the resulting token
And no request body, log line, database column, or error trace contains a PAN, CVV or expiry date

Given a booking request arrives at our server carrying raw card data
Then the request is rejected before processing
And the event is logged as a constraint violation without echoing the card data
```

### E6 — GST & ITC capture

> **The highest-ROI epic in the product.** ~₹12 lakh/year at this volume, uncorrectable after ticketing,
> and worth roughly as much as the entire fare-discount thesis ([research §5.3](./research.md)).

| ID | Requirement | Pri | G/A |
|---|---|---|---|
| **FR-GST-1** | **Booking is hard-blocked without a validated GSTIN and registered legal name.** No override, no "add later" (`CON-4`) | P0 | **[G]** |
| **FR-GST-2** | GST details are **pre-filled from the session's configured legal entity** (`CON-10`; from the traveller's entity once auth lands). A GSTIN can never be free-texted at booking time | P0 | **[G]** |
| **FR-GST-3** | The system warns when the legal entity's state differs from the route's place of supply, flagging possible unusable CGST/SGST credit | P1 | **[G]** |
| **FR-GST-4** | Both invoices are captured per booking: the **airline's** tax invoice for the fare, and the **agent's** invoice for service fees | P0 | **[G]** |
| **FR-GST-5** | GST rates are configuration (5% economy / 18% premium as of this spec), never hardcoded (`DEC-6`) | P0 | **[G]** |
| **FR-GST-6** | A finance export reconciles bookings line-by-line to GSTR-2B | P1 | **[G]** |
| **FR-GST-7** | Where a carrier operates a post-booking GST portal with a deadline, track it per booking and alert before expiry | P2 | **[G]** |

**Acceptance — FR-GST-1**
```gherkin
Given a traveller has selected a fare
When their legal entity has no validated GSTIN configured
Then the booking cannot proceed
And the traveller is directed to their travel admin
And no provider booking call is made

Given a booking has been ticketed
When anyone attempts to change the GSTIN on it
Then the system refuses and states the ticket must be cancelled and re-booked (CON-4)
```

### E7 — Post-booking servicing

**Largely `[A]`, and high-volume in a consulting context — trips change often.**

| ID | Requirement | Pri | G/A |
|---|---|---|---|
| **FR-SVC-1** | Travellers and arrangers view, change and cancel bookings in-tool | P0 | **[A]** |
| **FR-SVC-2** | Change/cancel flows show the actual fee before committing, using the carrier's corporate fare rules (`CON-8`) | P0 | **[G]** |
| **FR-SVC-3** | Cancellations produce a tracked refund or credit-shell record; unused credits are visible and reportable | P1 | **[A]** |
| **FR-SVC-4** | Name change is **not supported at launch** — rules were not established for any carrier ([research §4.3](./research.md)). Route to a human desk | P0 | **[G]** |
| **FR-SVC-5** | Disruption handling (cancellation, reschedule by carrier) notifies traveller and arranger | P2 | **[A]** |

### E8 — Reporting & analytics

| ID | Requirement | Pri | G/A |
|---|---|---|---|
| **FR-RPT-1** | **Corporate-fare attach rate** — % of bookings on a corporate fare where one was available. The product's headline metric | P0 | **[G]** |
| **FR-RPT-2** | **GSTIN attach rate** — % of bookings with valid GST details. Target 100%; every point of leakage ≈ ₹12,000/month | P0 | **[G]** |
| **FR-RPT-3** | Realised savings: corporate delta vs retail comparator, plus ITC recovered, per booking and in aggregate | P0 | **[G]** |
| **FR-RPT-4** | Spend by project code, cost centre, client-billable flag, traveller, route, carrier | P0 | **[A]** |
| **FR-RPT-5** | Policy compliance rate and out-of-policy reasons | P1 | **[A]** |
| **FR-RPT-6** | **Corporate query health** — failure rates by carrier and cause, from `FR-SRCH-4` | P0 | **[G]** |

---

## 8. Non-functional requirements

| ID | Requirement | Rationale |
|---|---|---|
| **NFR-1** | **Do not build for scale we do not have.** ~10 bookings/business day, ~400 users. Optimise for correctness, auditability and recoverability — not throughput (`CON-9`) | **[G]** |
| **NFR-2** | **Search returns results in under 5 seconds — a hard budget, not a target (`CON-11`).** Both legs are raced against the deadline; whatever has returned renders at 5s and the rest streams in behind. A slow or failed corporate leg never blocks retail rendering | `CON-2` makes two-leg search structural; `CON-11` |
| **NFR-3** | Every booking-affecting action is written to an immutable audit trail: actor, on-behalf-of, timestamp, before/after, credential used. **In v1 the actor is the session ID (`CON-10`)** — the field is populated from day one so records stay comparable after auth lands |
| **NFR-4** | All provider calls are logged with correlation IDs and are replayable for dispute resolution |
| **NFR-5** | Booking is idempotent under retry. A network failure mid-ticketing must never double-ticket (`FR-BOOK-7`) |
| **NFR-6** | Credentials live in a secret manager; never in the DB, logs, or client (`FR-ORG-3`) |
| **NFR-7** | Traveller PII and travel documents encrypted at rest; access role-restricted and logged. **DPDP Act 2023 applicability was not researched — legal review required** |
| **NFR-8** | **No card data touches the server at all (`CON-13`)** — not stored, not logged, not proxied. Only provider-issued tokens. This keeps us out of PCI-DSS cardholder-data scope; any change to it requires a PCI assessment first |
| **NFR-9** | Provider outages degrade gracefully: cached results marked stale, clear user messaging, no silent failure |

---

## 9. Success metrics

The product is working if these move. `FR-RPT-1`, `FR-RPT-2` and `FR-RPT-6` exist to measure them.

| Metric | Target | Why |
|---|---|---|
| **GSTIN attach rate** | **100%** | Uncorrectable after ticketing; ≈₹12 lakh/year at stake. The single highest-confidence lever |
| **Corporate-fare attach rate** | Baseline first, then improve | The stated product goal — but the denominator (fares actually available) is unknown until DEC-1/DEC-2 resolve |
| **Corporate query success rate** | >99% | A silent-failing second query destroys the whole thesis while looking healthy |
| **Realised saving per trip** | Model at **5–10% off published fare** | The only credible researched band; marketing ceilings of 30% are not achievable ([research §6.2](./research.md)) |
| **Booking completion time** | <3 min traveller self-serve | Leakage driver **[A]** — unresearched |
| **Leakage** (trips booked outside the tool) | Measure from expense data | Causes unresearched; the benchmark thread never ran |

---

## 10. Out of scope for v1

Hotels, ground transport, rail. International itineraries beyond simple point-to-point. Expense-report
generation (we emit data; the expense system owns the report). Duty-of-care traveller tracking. Name changes
(`FR-SVC-4`). Traveller-paid bookings and reimbursement. Multi-currency settlement.

---

## 11. Delivery phases

> **Superseded by [`plan.md`](./plan.md).** The horizontal phasing below (foundations → core → governance)
> would leave the client with nothing usable until phase 3. `plan.md` replaces it with six **end-to-end
> stages**, each shipping a complete working product. Retained here only as a record of the epic
> dependencies; **follow `plan.md` for delivery sequencing.**


| Phase | Contents | Exit criteria |
|---|---|---|
| **P0 — Foundations** | Domain model, `SupplyProvider` port, `MockAdapter`, org/legal-entity/config (E1), audit trail | Dual-search `CON-1` behaviour provably enforced against the mock |
| **P1 — Core booking** | Search orchestrator (E2), fare display (E3), booking + GST (E5, E6) | An end-to-end booking with GSTIN hard-block and corporate proof persisted |
| **P2 — Governance** | Policy evaluation + justification capture (`FR-POL-2`, `FR-POL-3`) against a default policy. **Approvals, arranger flows and grade-based policy defer to the auth milestone (`CON-10`)** | Out-of-policy booking requires a captured justification |
| **P3 — Operate** | Servicing (E7), reporting (E8) | Attach-rate and savings dashboards live |
| **P4 — Real supply** | Replace `MockAdapter` with the DEC-1 provider | Corporate fares retrieved from live inventory |
| **P5 — Identity** | Auth, roles, approvals, arranger flows; migrate session-scoped bookings per `DEC-7` | A booking is owned by a user, and approvals route |

**P4 can begin only when DEC-1 resolves — but P0–P3 do not wait for it.** That sequencing is the main
practical reason for the adapter port.

---

## 12. Assumption register

Every `[A]` requirement, to be confirmed before it is built.

| Area | Assumption | How to resolve |
|---|---|---|
| Personas | Arranger/proxy booking is heavily used | Ask the client how trips are booked today |
| Policy | Grade/band-driven policy with price caps and advance-purchase windows | Client's existing travel policy document |
| Approvals | Out-of-policy and over-threshold trips need approval; in-policy auto-approves | Client finance/HR |
| Per-client policy | Engagement clients impose travel rules that override the firm's | Client engagement leads |
| Project codes | Bookings must carry project/engagement codes for client rebilling | Client finance |
| Payment | Central corporate account; travellers never pay | `DEC-5` |
| Nudges | Ranking, badging and justification capture will lift corporate-fare adoption | **Unvalidated. Instrument and measure — the benchmark research never ran** |
| Leakage | Travellers bypass tools for price, UX and loyalty reasons | Unresearched |
| Expense | The client uses a separate expense system we export to | Ask which one |
| Session lifetime | How long an anonymous session stays valid, and what a user does when it expires holding a booking | Client (`CON-10`) |
| Booking retrieval | Whether an anonymous user needs any way back to a booking after the session ends — e.g. a reference code | Client (`CON-10`) — **an open hole in v1 servicing** |

---

## 13. Traceability

| Epic | Grounding | Confidence |
|---|---|---|
| E1 Organisation & config | research §3.4, §5.4, §6.1 | High on GST fields, medium elsewhere |
| E2 Search & retrieval | research §1, §2, §3.3, §3.4 | **High — primary vendor documentation** |
| E3 Fare presentation | research §4, §5.3, §6.2 | Medium — display grounded, nudges are hypotheses |
| E4 Policy & approvals | *none* | **Low — standard patterns only** |
| E5 Booking & ticketing | research §3.3, §3.4 | High |
| E6 GST & ITC | research §5 | **High on mechanics; rates need CBIC verification (DEC-6)** |
| E7 Servicing | research §4.3 | Medium — fees grounded, flows assumed |
| E8 Reporting | research §5.3, §6.2 | Medium |

**Client-supplied constraints** (`CON-10`–`CON-13`, 2026-08-22) are authoritative and need no research
grounding — but note that `CON-10` (no auth) defers `FR-POL-1`, `FR-POL-4`, `FR-POL-5`, `FR-POL-6`,
`FR-BOOK-2`, `FR-ORG-5` and `FR-ORG-6`, and degrades `NFR-3` actor attribution. §2.1 tracks the full
dependency chain.

**Open research feeding this spec:** `research.md` §8 Tiers 1–3. Tier 1 items gate `DEC-1` and `DEC-2`.
