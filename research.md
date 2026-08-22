# Corporate Flight Booking Platform — Market & Competitor Research

**Client:** consulting firm, 400 consultants, ~200 business trips/month, India-domestic-dominant
**Product posture:** self-booking tool (SBT). We build search/booking UX, policy engine, approvals, reporting. Flight inventory sourced from aggregator/GDS supply.
**Core product goal:** maximise capture of **airline corporate fares**.
**Version:** 0.2 · **Date:** 2026-08-22

---

## 0. Status — read this before using the document

Research was commissioned across five threads. **One completed. Three were stopped when the search budget
ran out. One did not report.** Everything below rests on the single completed thread (airline corporate
fare programmes + distribution mechanics) plus its four raw sub-files.

| Thread | Status | Consequence |
|---|---|---|
| Airline corporate fares + distribution | ✅ **Complete** (47 tool calls) | §2–§5 are well-evidenced |
| India competitor teardown | ⛔ Stopped — budget exhausted | **§6 is thin. This was your #1 priority.** |
| Global feature/nudge benchmark | ⛔ Stopped before starting | No nudge-design research at all |
| India aggregator supply landscape | ⛔ Stopped — budget exhausted | The supply decision remains open (§3.6) |
| Personas & requirements | ⚠️ No report | §7 is my synthesis, not researched |

**The document is therefore inverted relative to your stated priorities.** You asked for competitor teardown
first and product requirements second; what exists is deep on distribution plumbing and thin on both of
those. §8 lists exactly what a second pass must close, in priority order.

### Confidence legend — applied to every non-obvious claim

| Tag | Meaning |
|---|---|
| **[P]** | Primary source, actually fetched and read |
| **[S]** | Secondary — search snippet or third-party summary; source page never rendered |
| **[U]** | Named but unverified; a lead |
| **[I]** | Inference — reasoning from evidence, not evidence |
| **[D]** | Derived — arithmetic or synthesis of mine |

**Environmental caveat that shaped the data:** `goindigo.in` (timeout ×4), `airindia.com` (timeout ×2),
`mybiz.makemytrip.com` and `yatra.com/business-v2` all failed to load; `6esme.goindigo.in` fails DNS
outright. `corporate.spicejet.com`, `akasaair.com`, `itilite.com` and `support.travelport.com` answered.
**The depth asymmetry below tracks which servers responded — not which programme is better designed or
more important.** IndiGo, the carrier that matters most here, is the one we could read least about.

A second structural caveat, and a finding in its own right: **detailed corporate fare terms are
contract-only across every Indian carrier.** Several cells below are genuinely unknowable from public
sources and will require airline sales conversations.

---

## 1. The headline finding

> **How a corporate fare is *unlocked* differs fundamentally between India's full-service carriers and its
> LCCs — and for IndiGo, the dominant domestic carrier, it is not a code in the request payload. It is the
> credential you shop with.**

Travelport's public IndiGo requirements page states **[P]**:

> "If your agency handles both Corporate and Retail fares, you will need separate Agency IDs/PCC for each."

Mixing corporate and retail 6E fares raises **warning code 701422** and the pricing/booking fails **[P]**.

**Architectural consequence [I]:** an SBT that wants to show IndiGo retail *and* IndiGo corporate on one
results page must run **two parallel searches against two separately-provisioned credentials**, **merge
client-side**, and **guarantee no cart or PNR ever mixes the two**. This is a real architectural
requirement, not a config flag — and it must be settled before any UI is designed.

It also means the "you saved ₹X vs retail" comparison the product wants to show is a **client-side join of
two independent search responses**, inheriting all the latency and consistency problems that implies.

**Corollary [P]:** corporate fares do **not** appear in normal search results, on any carrier, by design.
Every mechanism found requires a distinct credential (IndiGo/ACH), an account code in the request (FSC), a
promo code (Akasa `CSME04PS`, IndiGo partner portal), or an authenticated corporate portal session. **Plan
for a parallel query in all cases**, and instrument its success rate — because a silently-failing second
query looks exactly like "no corporate fare available today."

---

## 2. Vocabulary — four terms vendors use interchangeably that mean different things

Getting these wrong is how integrations fail. All **[P]**.

| Term | What it actually is | Where it lives |
|---|---|---|
| **Published / public fare** | Filed with ATPCO, visible to all, no code needed | ATPCO, all GDSs |
| **Private fare** | Filed to be visible only to a specific audience. Umbrella term; Travelport splits *airline private* vs *agency private* | ATPCO Cat 15 / Cat 35 |
| **Negotiated fare** | Specifically the ATPCO **Category 35** construct — net/selling amount from a commercial agreement | ATPCO Cat 35; Amadeus ANF |
| **Account code** | Short string sent in the **shopping request** to unlock a private fare. **This is the retrieval key** | The API request |
| **Tour code** | Written **onto the ticket** at ticketing, recording the agreement. **Documentation, not retrieval** — unlocks nothing. Amadeus element `FT`, max 12 chars | The ticket |

**Load-bearing distinction:** the *account code* makes the fare appear at search time; the *tour code* makes
the airline honour the deal at ticket time. **An SBT needs both, configured in different places.**

---

## 3. Distribution — how a third party actually retrieves these fares

The best-evidenced section in the document.

### 3.1 Amadeus

- **Self-Service API is disqualified** — **published fares only**, no corporate content at any price tier.
  This closes off "just sign up for the free Amadeus API" entirely. **[P]**
- Corporate content needs an **Enterprise API commercial agreement**; Enterprise docs are not public. **[P]**
- **Unifares** is the umbrella for discounted content, built over ATPCO Cat 15 private, ATPCO Cat 35
  negotiated, and Amadeus's own Cat 35 filings. **[P]**
- Corporate identity is a **contract number or corporate name on the fare-quote request** — a first-class
  search qualifier. Cryptic entries confirm the parameter shape: `FQDNYCMAD/R,U364477` (contract number),
  `FQDNYCMAD/R,UU*IBM` (corporate name), `FQDNYCMAD/R,C364477` (negotiated). `FXD` = Master Pricer. **[P]**

### 3.2 Sabre

- **Bargain Finder Max (BFM)** supports negotiated fares across **both ATPCO and NDC**. **[P]**
- For NDC, Sabre looks up and **sends the appropriate account codes to each airline on the route** — the
  caller does not fan codes out per-carrier. A meaningful ops saving if NDC matters later. **[S]**
- Elements: `CarrierSpecificQualifiers` within `NDCIndicators` (agency-held airline account code → private
  fares / corporate bundles); `TravelerInfoSummary` → `PriceRequestInformation`. **[S]** — the v5 page
  rendered as an empty SPA shell; names came from the search index and a 2020 PDF. **Verify before building.**
- Full BFM schemas are **gated behind a developer account**. **[P]**

### 3.3 Travelport — best-documented, most relevant to India

The Universal API webhelp is **fully public, no login** — the most citable source in this research, and the
most practical integration target. All **[P]**.

**Request-side levers:**
- `AirPricingModifiers/AccountCodes/AccountCode@Code` — a **single** account code. **Both** the supplier's
  account code and the provider code must be specified.
- `ContractCodes/ContractCode@Code` — accepts **multiple** codes (Rule ID / contract path, ATPCO + ACH).
- **`@AccountCodeFaresOnly="true"`** — restricts the response to **only** fares tied to the supplied code.
  **This is the flag an SBT wants on** — it turns "the corporate fare is in there somewhere" into "only
  corporate fares came back."
- **`@FaresIndicator`** — `AllFares` (default) | `PublicFaresOnly` | `PrivateFaresOnly` |
  `AgencyPrivateFaresOnly` | `AirlinePrivateFaresOnly` | `NetFaresOnly` | `PublicAndPrivateFares`.
  **The cleanest "corporate content only" lever in any GDS API.**
- Contract/account code applies to the **entire journey, never per segment**.

**Response-side markers — how you *prove* a corporate fare was applied:**
`AirPricingInfo@PrivateFare` · `@NegotiatedFare="true"` · `FareInfo@PseudoCityCode` (presence ⇒ private
fare) · `LowFareSearchReq/PointOfSale@PseudoCityCode` (private-fare redistribution).

These matter more than they look. Without a reliable response marker you cannot build the "you booked the
corporate fare / you didn't" feedback loop that the entire behavioural design in §7 depends on.

**Worked corporate examples in the docs** (non-Indian, structurally identical): Air Canada SME rewards via
`AccountCode @SupplierCode="AC" @Type="RFB" @ProviderCode="ACH"`; easyJet via `ContractCode @SupplierCode="U2"`.

### 3.4 IndiGo on Travelport ACH — the documented path

IndiGo rides **ACH** (Airline Content Hub), Travelport's LCC/API-carrier pipe, not ordinary ATPCO content.
All **[P]**:

- **Corporate/retail credential split and warning 701422** — see §1.
- **Provisioning:** Agency ID required for corporate fares *or* agency form of payment; Login ID goes in the
  **ZPROV Access Code** field; User ID contains the Agency ID in ZPROV config.
- **`SSR CPTR`** (Corporate Traveler), uAPI **22.2.2+**: `<SSR Type="CPTR" Carrier="6E" Status="HK"/>` —
  unlocks free baggage allowance, free meal, free seat selection.
- **GST fields (mandatory):** Company Name + Tax ID via `SSR GSTN`, email via `SSR GSTE`. GSTIN = **15
  alphanumeric chars with positional rules** (1–2 numeric, 3–7 alpha, 8–11 numeric, 12 alpha, 13–15
  alphanumeric). **The GST SSRs must appear in BOTH `AirPriceReq` AND `AirCreateReservationReq`.**
- **Post-book GST modification is NOT supported.** The GSTIN must be correct at booking time — see §5.
- Hold bookings supported on both retail and corporate fares (carrier-determined TTL); BSP payment supported.
- Fare brands: Stretch (business), Super 6E / Upfront, Flexi. Student fares discontinued **2025-08-26**;
  Marine fares effective **2026-03-31**.
- **ACH coverage gap:** the public ACH Carrier Requirements index lists carrier pages for **Air Canada,
  IndiGo and Ryanair only**. SpiceJet, Air India, Akasa and Vistara have none — which does **not** prove
  unavailability, only that they carry no documented carrier-specific requirements.

> **Highest-value unread document in the entire research set:** Travelport's IndiGo 6E uAPI implementation
> guide (761 KB PDF) — downloaded but **never parsed** (no PDF text extractor available in the research
> environment). **Read this first in any follow-up.**

### 3.5 Indian aggregators — not established, and this blocks the supply decision

**Zero verification completed.** Do not cite anything here yet.

- **Tripjack** — the highest-value target (the common India B2B pipe). **`apidoc.tripjack.com` does not
  resolve publicly**; docs are partner-gated. Whether `fareIdentifier` carries `RETAIL` / `CORPORATE` /
  `SME` values is **unconfirmed**. Vendor marketing claims it "allows businesses to manage private and
  special fares" — marketing, not documentation. **[U]**
- **TBO / TekTravels** — `ResultFareType`, `IsCorporateFare`, `PublishedFare` vs `OfferedFare`,
  `GSTCompanyDetails`: **all unconfirmed**. API is RESTful/JSON; field docs require a TBO account. **[U]**
- **Verteil, Mystifly OnePoint, Riya, Akbar Travels B2B** — not researched.

> **Finding in its own right:** **every Indian aggregator's field-level API documentation is partner-gated
> and none is publicly readable.** Answering the single most important remaining question requires signing
> an NDA or partner agreement first. That is a schedule item, not a research task.

### 3.6 Supply options — ranked as far as the evidence allows

1. **Amadeus Self-Service — OUT.** Published fares only. **[P]**
2. **Any GDS route is a commercial negotiation, not a signup.** Amadeus Enterprise, Sabre and Travelport all
   gate corporate content behind an enterprise agreement plus a provisioned PCC/Agency ID. **Budget
   contracting time, not just integration time.** **[P]**
3. **Travelport is the best-documented build target** — public webhelp, explicit levers, and the only
   *documented* Indian-carrier corporate path (IndiGo via ACH). **[P]**
4. **IndiGo needs a dual-credential architecture regardless of channel.** Design for it from day one. **[I]**
5. **SpiceJet is commercially open to the agent channel** — its own FAQ permits booking "through your
   nominated travel agent(s)". The *technical* channel is unverified. **[P]**
6. **An Indian aggregator (Tripjack / TBO) is probably the pragmatic path** for a 200-trip/month firm that
   won't hold its own IATA licence — **but this is [I] and unproven, and it is the next thing to research.**
7. **GST plumbing is mandatory and non-trivial** — validation plus SSRs in both price and book calls, with
   no post-book correction. **[P]**

**Still not established:** IATA licence requirements, PCI scope, consolidator-vs-direct commercials, and the
aggregator comparison — i.e. the actual ranked recommendation. **Needs a second pass.**

---

## 4. Airline corporate programmes

| | **IndiGo (6E)** | **Air India (AI)** | **Akasa (QP)** | **SpiceJet (SG)** | **AI Express (IX)** |
|---|---|---|---|---|---|
| **Programme** | 6E SME Flyer Program | **AI BIZ** (SME) + separate **Corporate Travel Programme** (large enterprise) | SME corporate booking platform | Corporate Benefit Program; "SME Traveller" (2014, liveness doubtful) | **FlyBiz** SME |
| **Source quality** | **[S]** — domains unfetchable | **[S]** — all fetches timed out | **[P]** press release | **[P]** 2 pages read | **[U]** URL only |
| **Tiering** | SME confirmed; large track exists, unverified | **Two explicit tiers** | SME confirmed | Single contract programme | SME only |
| **Enrollment** | Form + docs on dedicated portal; IndiGo approves at discretion | Register at `aibiz.airindia.com`; credentials **"provided"** ⇒ approval step **[I]** | Self-register `sme.akasaair.com/login` | **Contract with the organisation**; relationship manager | Portal |
| **Approval SLA** | **48 working hours** | Not published | Not published | None published | Not published |
| **Min spend/volume** | **Not published** | **Not published** | **Not published** | Intake brackets: <500 / 500–1,000 / >1,000 employees; ≤₹20L / ₹20–75L / ₹75L+ annual spend — *thresholds or just segmentation, unclear* | Not published |
| **Headline discount** | "up to 30% off applicable **market rates**" ⚠️ | Not published | Promo `CSME04PS`; up to **50% off premium seating** (ancillary, not fare) | "30–50% lower than **FSC** fares" ⚠️; SME Traveller ~10% (2014) | "up to ₹6,000 off" (coupon site, low trust) |
| **Change/cancel** | Cancel ≈ **₹999–1,499** + SC + GST; reschedule from **₹499** + fare diff | Cancel ≈ **₹2,300** (6–74h) / **₹1,300** outside | **No change/cancel fee to T-1h domestic** (fare diff + admin fee apply); corporate cancel ≈ **₹250** | Change **and** cancel ≈ **₹450** + SC + GST to T-6h | Not established |
| **Free seat/meal/bag** | Complimentary meal; free seat & bag via `SSR CPTR` | Not established | **Complimentary standard seat + snack on every flight**; 30kg intl | Meal & beverage (to T-6h); preferred seating | Not established |
| **GST invoicing** | `SSR GSTN`/`GSTE` mandatory, positional validation | "GST billing" advertised | Not established | Not established | Not established |
| **Third-party bookable?** | **YES via Travelport ACH — with a separate IndiGo-issued Agency ID/PCC.** Best-evidenced answer here | **Unknown.** Portal-shaped for SME **[I]** | **Unknown** — portal-shaped **[I]** | **YES commercially** — "directly or through your nominated travel agent(s)" **[P]** | Unknown |

### 4.1 ⚠️ Two numbers that must not enter a savings model

1. **SpiceJet's "30–50%"** is *"lower than **full service carriers'** fares"* **[P]** — an LCC-vs-FSC
   positioning claim, **not** a discount off SpiceJet's own retail fare. The real corporate delta versus
   SpiceJet retail is stated nowhere public.
2. **IndiGo's "up to 30%"** is off *"applicable **market rates**"*, capped by "up to", and applies to
   **standard seats subject to availability** **[S]**. It is a marketing ceiling, not an expected average.
   Realised discount will be materially lower **[I]**.

### 4.2 The strongest positive signal for our channel

A TMC help-desk publishes **per-airline corporate/SME fare change and cancellation charges side by side for
IndiGo, Air India, Akasa, SpiceJet and Vistara** **[S]**. That means corporate/SME fares are **bookable,
differentiated fare products in the agent channel across carriers** — not portal-only curiosities. This is
the strongest *indirect* evidence that a third-party platform can transact corporate fares broadly, and it
partly offsets the portal-shaped appearance of the AI BIZ and Akasa SME sites.

Separately, a third-party agent knowledge base documents IndiGo's **partner-portal flow: 6E ID login +
promo code** to select a corporate fare **[S]** — evidencing a second, promo-code-driven IndiGo corporate
channel inside an authenticated agent portal. Note this is a **human web portal, not a documented API.**

> ### ⚠️ Open risk to the engagement premise
> **We do not know which tier a 400-consultant firm falls into for IndiGo or Air India.** Both run a
> self-serve SME track and a separate negotiated large-enterprise track. If ~400 staff / ~200 trips a month
> sits *above* the SME threshold but *below* real negotiating volume, the client may land in a gap where
> neither track delivers a meaningful discount. **This is a commercial-viability question, not a technical
> one, and it should be answered before build commitment.**

### 4.3 Constraints on corporate fares

| Constraint | Finding |
|---|---|
| **Refundable?** | Not free — all carriers charge a *reduced*, not waived, cancellation fee. **Akasa is the outlier**: no change/cancel fee to T-1h domestic (fare difference + admin fee still apply) |
| **Changeable?** | Yes, reduced fees + fare difference. IndiGo claims "unlimited flexibility for changes" |
| **Name change** | **Not established for any carrier.** Materially important for a consulting firm — trip reassignment is common. Ask directly in contract talks |
| **Promo-combinable?** | **Not established.** Unlikely **[I]** — several programmes *are themselves* promo-code-driven, so stacking is probably blocked |
| **Mix corporate + retail** | **Explicitly prohibited on IndiGo/Travelport** — warning `701422` |
| **Separate search needed?** | **Yes, effectively always** (§1) |
| **Inventory/RBD caps** | **Not established.** IndiGo's "subject to availability" implies capped inventory **[I]** |

### 4.4 Not researched

Vistara merger fallout (Corporate Connect / Club Vistara post Nov-2024); 6E BluChip / 6E Rewards / IndiGo
for Business; Akasa's programme terms beyond the press release; smaller carriers (Star Air, Alliance Air,
FLY91).

---

## 5. GST input tax credit — probably the biggest single savings lever

**Confidence: Medium.** Sourced from tax explainers and travel-platform guides, **not primary CBIC
circulars.**

### 5.1 Rates (as reported by 2026-dated sources) **[S]**

- **Domestic economy: 5%**
- **Business / premium economy / first: 18%** — reportedly **up from the historic 12%**, consistent with the
  2025 GST rate rationalisation. **Verify against a primary CBIC notification before relying on it.**
- GST-registered businesses can claim ITC on **both** rates for genuine business travel.

*(This corrects the 12% figure used in v0.1 of this document.)*

### 5.2 The three mandatory conditions for ITC to flow **[S]**

1. **GSTIN entered at booking, before the PNR is generated.** Airlines and OTAs **cannot add it later** —
   inventory systems lock the tax-invoice payload at ticketing. Independently confirmed by Travelport's
   IndiGo page: *"Post-book GST modifications aren't supported."* **[P]**
2. **Tax invoice in the company's exact registered legal name + GSTIN.** **Wrong-name invoices cannot be
   corrected post-issuance — the ticket must be re-booked.**
3. **Reconciled in GSTR-2B before claiming in GSTR-3B.**

Eligibility covers employee and director business travel, excluding personal travel and items blocked under
**Sec 17(5) CGST Act**. The precise post-2023-amendment treatment of 17(5)(b) employee travel benefits was
**not verified** — confirm with the firm's tax advisor.

### 5.3 The arithmetic **[D]**

Domestic economy, ₹6,000 base, 5% GST = ₹300 → recovering it is a **~4.8% reduction in all-in cost**
(300/6300). Business class at 18% on a ₹20,000 base: ₹3,600 GST → **~15.3% of all-in**.

**At this client's scale**, ~200 trips/month at ~₹10,000 base:
- Monthly base air spend ≈ **₹20 lakh**; annual ≈ **₹2.4 crore**
- Recoverable ITC ≈ **₹1 lakh/month ≈ ₹12 lakh/year**
- **Every 1% of GSTIN-attach leakage ≈ ₹12,000/month**

> ### The strategic claim **[D]**
> **ITC capture (~4.8% of all-in economy spend) is the same order of magnitude as — or larger than — the
> 5–10% off-published-fare discount that the only credible vendor source claims for air.** Unlike a fare
> discount it needs **no airline contract, no volume commitment, no negotiation**. It is a pure
> process-and-software win, entirely within our control.
>
> **Implication:** "encourage corporate fares" is too narrow a framing for the product goal. The objective
> should be **minimise landed cost per trip = corporate fare + guaranteed ITC capture + policy compliance**.
> A booking on a slightly worse fare *with* GSTIN correctly attached can legitimately beat a better fare
> without it.
>
> **If the product does only one thing perfectly, it should be flawless GSTIN attach.**
>
> This rests on arithmetic plus the 5% rate, which is still unverified against a primary CBIC notification.

### 5.4 What the SBT must capture at booking — hard requirement

Corporate **GSTIN** (15 chars, positional validation) · **exact registered legal name** as on the GST portal
· registered **address / state code** (place of supply drives CGST+SGST vs IGST) · **invoice email**.

**The practical failure mode:** GSTIN missing or mistyped, or a legal-name mismatch — neither correctable
afterwards. **Hard-block booking without a validated GSTIN, pre-fill from company config, and never let an
individual consultant free-text it.**

**Invoice split to design for:** the **airfare invoice comes from the airline** (ITC on the fare flows from
the airline's GSTIN); the **agent's convenience/service fee is a separate invoice** from the OTA/TMC. Both
need capturing for full recovery. myBiz independently confirms this structure — it collects company PAN +
GSTIN at registration and states ITC is availed *"by getting GST invoices from hotels and airlines"* **[S]**.

---

## 6. Competitive picture — thin (thread stopped)

### 6.1 The one genuinely useful competitive insight

Two distinct product models exist, and **our SBT must consciously pick one or support both [I]**:

| Model | Who | How it works | What the corporate gets |
|---|---|---|---|
| **1. Consolidator-resale** | myBiz **[S]**; probably most Indian OTAs | Platform sells *its own* negotiated inventory to all corporate customers | A discount, but **owns no airline relationship and cannot port the deal** |
| **2. BYO / private-fare loading** | ITILITE **[P]**; Concur, Navan, Amex GBT expected **[U]** | Corporate signs its *own* airline programme; platform files/loads the codes so those fares surface | Owns the relationship; the deal travels with them |

**ITILITE is the only platform with evidenced BYO support [P]:** *"Full Prism data submission, rate loading,
and testing handled for you."* Prism is the airline private-fare filing system — i.e. the client's own
negotiated rates are filed on their behalf. A search summary adds that own-negotiated rates *"appear at the
top of search results"* **[S]** — worth verifying literally, because ranking preferred fares first is
exactly the nudge mechanic our product goal calls for.

**The pivotal unanswered question:** ITILITE's negotiated-rates page is **US-facing** (Delta, United, AA,
Southwest). **Whether the same BYO rate-loading exists for IndiGo / Air India / Akasa / SpiceJet on
ITILITE's India entity is unverified.**

**myBiz** — consolidator-resale confirmed; markets *"pre-negotiated fares at no additional cost"* from MMT's
own supplier agreements, and references **"corporate coding with airlines"** enabling "zero cancellation
penalties and airline discounts" **[S]**. **No page found letting a corporate attach its own airline code** —
flag as *thin/unpublished*, not *proven absent*.

**Yatra for Business** — claims "negotiated rates applicable for their organization" **[S]**; phrasing is
ambiguous between models 1 and 2. **Unresolved.** Its SEBI/investor filings were expected to be the best
hard-numbers source in the brief and were **never pulled**.

**Working recommendation [I], low confidence:** at 400 consultants / ~200 trips a month the client is
likely **too small to win strong direct airline contracts, but large enough to matter to a consolidator**.
So **build on model 1, architect for model 2** — hold BYO capability open rather than shipping it. BYO is
what separates a real corporate SBT from a rebranded OTA, and depends on airline volume thresholds that
were never researched (§4.2).

### 6.2 Published savings claims — treat with suspicion

| Claim | Source quality | Verdict |
|---|---|---|
| **ITILITE: 5–10% off published fares, airlines specifically** | Vendor product page **[P]** | **The most credible airfare figure found. Use this band.** |
| ITILITE "up to 30%" | Vendor marketing **[P]** | **All-categories** (air+hotel+car), not airfare. A common, expensive misread |
| IndiGo "up to 30% off market rates" | T&C snippet **[S]** | Marketing ceiling; realised average lower **[I]** |
| SpiceJet "30–50% lower" | Primary **[P]** | **Invalid as a corporate discount** — vs FSCs |
| SpiceJet SME Traveller "up to 10%" | 2014 press **[S]** | Plausible as real, but 12 years old and likely dead |
| Akasa "up to 50% off premium seating" | Primary **[P]** | Real, but on **ancillaries**, not base fare |
| **ITC recovery ~4.8% of all-in economy** | **[D]** | **Most reliable savings lever found** |

**Honest read:** beyond ITILITE's 5–10% there is **no credible published figure** for the average realised
discount of an Indian airline corporate fare versus that airline's own retail fare. Anyone quoting "20–30%
savings" for Indian corporate air is extrapolating from marketing ceilings **[I]**. **Model conservatively.**

### 6.3 Competitors with zero research

**Cleartrip for Business, EaseMyTrip for Business, Happay/Dice, SAP Concur India, Navan/Tripeur India,
Amex GBT/Egencia India, Thomas Cook India, FCM India, MMT Quest2Travel.** Also: **supply stack (GDS vs
aggregator vs NDC) is undisclosed for every platform including ITILITE and myBiz** — treat as unknown
across the board.

---

## 7. Derived product implications

**Synthesis [D], not researched findings** — the requirements thread never reported. Treat as hypotheses to
test against a real teardown.

### 7.1 Architectural constraints that are already firm

| # | Constraint | Source |
|---|---|---|
| A1 | **Dual-credential search for IndiGo** — two Agency IDs/PCCs, parallel searches, client-side merge, hard cart-level guarantee against mixing | §1, §3.4 **[P]** |
| A2 | **Search must carry account/contract codes as a first-class parameter**, not a post-filter | §3.1, §3.3 **[P]** |
| A3 | **Account code and tour code are separate concerns** — retrieval vs ticket documentation | §2 **[P]** |
| A4 | **GST SSRs in both price and book calls**, with 15-char positional validation client-side before submit | §3.4 **[P]** |
| A5 | **Persist private-fare response markers** on every booking record — they are the evidence base for all savings reporting and every nudge | §3.3 **[P]** |
| A6 | **Amadeus Self-Service disqualified**; any GDS route is a contract negotiation. Travelport is the best-documented target | §3.1, §3.6 **[P]** |
| A7 | **Corporate content requires a deliberate parallel query that can fail silently** — instrument corporate-fare attach rate as a first-class metric | §1 **[P]** |

### 7.2 Requirements for the corporate-fare goal, ranked by savings-per-unit-of-effort

1. **Guaranteed GSTIN attach on 100% of bookings.** Highest confidence, highest ROI, zero external
   dependency. Structurally impossible to book without a validated GSTIN and correct legal entity;
   pre-filled from company config, never free-texted; place-of-supply check against registered states.
   **≈₹12 lakh/year at stake, and it is uncorrectable after ticketing.**
2. **Corporate-fare attach-rate instrumentation.** The second query is silent when it fails. Measure it
   before optimising anything else.
3. **Corporate-fare-first ranking with proof.** Use `@AccountCodeFaresOnly` / `FaresIndicator` to guarantee
   retrieval, rank corporate first, and badge it using the response markers. ITILITE's "top of search
   results" suggests this is the established pattern **[S]**.
4. **Landed-cost display, not fare display.** Fare + GST + recoverable ITC + change-fee exposure. This is
   where the ITC lever becomes visible and where a corporate fare with a worse headline can correctly win.
5. **Change/cancel economics surfaced at search time.** A consulting firm has high change rates, and the
   corporate change/cancel deltas are real and now quantified (§4) — Akasa's fee-free-to-T-1h in particular
   is a genuine differentiator that belongs in ranking, not fine print.

### 7.3 What I cannot yet specify

Policy engine design, approval workflows, behavioural nudge mechanics, arranger/proxy booking, project-code
and client-billability capture, duty of care, expense integration. **§7.2 is deliberately narrow — it covers
only what the distribution evidence actually supports.**

---

## 8. Next research pass — ordered by decision impact

**Tier 1 — could invalidate the approach**
1. **Do Tripjack / TBO / Verteil expose corporate fares via API?** Docs are partner-gated — this needs
   partner contact, not searching. **Blocks the supply decision.**
2. **Parse the IndiGo-on-Travelport implementation guide PDF** (761 KB, downloaded, unparsed).
3. **Does a 400-consultant firm qualify as SME**, or fall into the large-corporate gap, for IndiGo and
   Air India? (§4.2) — commercial viability.
4. **Real corporate discount vs each airline's own retail fare.** Unknown for every Indian carrier.

**Tier 2 — your stated priorities, still unmet**
5. **Competitor teardown:** Cleartrip for Business, EaseMyTrip, Happay/Dice, Concur India, Navan India.
   Plus **Yatra Online SEBI filings** for hard numbers.
6. **Does ITILITE India do BYO rate-loading for Indian carriers?** (§6.1) — the pivotal competitive question.
7. **Behavioural nudge patterns** — Navan's traveller-incentive mechanic and how it is funded. The closest
   precedent for "encourage corporate fares", and currently entirely unresearched.
8. **Requirements thread:** policy engine, approvals, arranger booking, project-code capture, leakage causes.

**Tier 3 — verification debt on what is written above**
9. Airline GST-portal URLs and GSTIN-entry deadlines: IndiGo, Air India, Akasa, SpiceJet.
10. **Verify the 5% / 18% GST rates against a primary CBIC notification.**
11. CGST Sec 17(5)(b) post-2023 bare text; IGST s.12(9) place-of-supply with multi-state GSTIN.
12. **Name-change and promo-combinability rules** — not established for any carrier, operationally important.
13. Sabre BFM v5 elements against live docs (currently from a 2020 PDF).
14. NDC India state of play; Air India post-Vistara corporate structure.
15. Is SpiceJet "SME Traveller" still alive? ("SpiceBiz" — no evidence it exists at all.)

---

## 9. Sources

**Primary — fetched and read**
- Travelport uAPI — [IndiGo Requirements](https://support.travelport.com/webhelp/uapi/Content/Air/ACH_CarrierFunctionality/Supplier_Requirements_IndiGo.htm) · [Air Pricing](https://support.travelport.com/webhelp/uapi/Content/Air/Air_Pricing/Air_Pricing.htm) · [Air Pricing by Fare Type](https://support.travelport.com/webhelp/uapi/Content/Air/Air_Pricing/Air_Pricing_by_Fare_Type.htm) · [Low Fare Shopping (Sync)](https://support.travelport.com/webhelp/uapi/Content/Air/Low_Fare_Shopping/Low_Fare_Shopping_(Synchronous).htm) · [ACH Carrier Requirements](https://support.travelport.com/webhelp/uapi/Content/Air/ACH_CarrierFunctionality/ACH_Carrier_Requirements.htm) · [ACH Overview](https://support.travelport.com/webhelp/uapi/Content/Air/ACH_CarrierFunctionality/ACH_Functionality.htm) · [Smartpoint GST](https://support.travelport.com/webhelp/smartpointcloud/Content/SPC/GST.htm)
- Amadeus — [Flight Offers Search](https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search) · [Fare types overview](https://servicehub.amadeus.com/c/portal/view-solution/807641/overview-of-the-different-fare-types) · [Tour code (FT)](https://servicehub.amadeus.com/c/portal/view-solution/885491/en_US/ticketing-and-fare-elements-tour-code-ft-) · [FQD cryptic options](https://servicehub.amadeus.com/c/portal/view-solution/716365606/how-to-request-a-fare-display-fqd-with-options-cryptic-) · [Master Pricer (FXD)](https://servicehub.amadeus.com/c/portal/view-solution/1011941442/master-pricer-fxd-reference-guide)
- SpiceJet — [Corporate FAQ](https://corporate.spicejet.com/CorporateFaq.aspx) · [Corporate Benefit Program](https://corporate.spicejet.com/corporatequeries.aspx)
- Akasa — [SME platform press release, 15 Jul 2025](https://www.akasaair.com/news-room/akasa-press-releases/akasa-air-launches-dedicated-sme-corporate-booking-platform)
- ITILITE — [Negotiated rates](https://itilite.com/corporate-travel-negotiated-rates/)

**Secondary / lower confidence**
- Sabre — [BFM v5](https://developer.sabre.com/rest-api/bargain-finder-max/v5) (SPA shell) · [BFM NDC Guide PDF, 2020](https://developer.sabre.com/sites/default/files/2020-04/BargainFinderMax_NDC_Guide_2020.pdf)
- [Velocity Travel — Domestic Airlines Fare Rules for Business Travel](https://helpdesk.velocity.travel/support/solutions/articles/1070000077696-domestic-airlines-fare-rules-for-business-travel) (per-airline corporate/SME change & cancel charges — the §4.2 evidence)
- [Tripmaza KB — Booking Corporate Fare on IndiGo](https://support.tripmaza.com/portal/en/kb/articles/how-to-book-corporate-fare-in-indigo-website) (6E ID + promo code flow)
- myBiz — [GST invoice / ITC guide](https://mybiz.makemytrip.com/corporate/gst-invoice-flights.html) · [Corporate travel benefits](https://mybiz.makemytrip.com/corporate/corporate-travel-benefits-for-businesses.html) (snippets; fetches timed out)
- Yatra — [/business/](https://www.yatra.com/business/) · [Skift, 2024-11-13](https://skift.com/2024/11/13/yatra-focuses-on-corporate-travel-as-consumer-business-faces-competition/)
- GST explainers — [HappyFares ITC guide](https://www.happyfares.in/blog/gst-itc-flight-tickets-business-claim-step-by-step-india/) · [HappyFares rates 2026](https://happyfares.in/blog/gst-on-flight-tickets-in-india-2026-rates-itc-savings/) · [TripGain handbook](https://tripgain.com/blogs/gst-and-itc-on-flight-bookings-a-handbook-for-smarter-travel-and-expense-management-1)
- [Business Standard, 2014 — SpiceJet SME Traveller](https://www.business-standard.com/article/news-ians/spicejet-launches-booking-tool-discount-scheme-for-sme-travellers-114092300544_1.html) · [Aviate Amadeus guide PDF](https://www.aviateworld.com/media/4233/aviate-amadeus-user-guide.pdf) · [IndiGo on Travelport (galileo.lk)](https://www.galileo.lk/files/Indigo%20Travelport.pdf)

**Leads — never fetched**
- [Travelport IndiGo 6E uAPI implementation guide (PDF)](https://support.travelport.com/webhelp/uapi/Content/Air/ACH_CarrierFunctionality/Indigo_6E_implementation%20guide_only_for_uAPI-v5.docx.pdf) ← **read first**
- IndiGo: `goindigo.in/information/6e-sme.html` (timeout ×4) · `6esme.goindigo.in/IndiGoSMESite/` (DNS fail) · `goindigo.in/info/mice/india-sme.html`
- Air India: [AI BIZ](https://www.airindia.com/in/en/book/ai-biz-corporate-flight-booking.html) · [AI BIZ T&C](https://www.airindia.com/in/en/ai-biz-terms-and-conditions.html) · `aibiz.airindia.com/register-corporate` · `sme.airindia.com/bridge/loginCorporateUser`
- [AI Express FlyBiz](https://www.airindiaexpress.com/book-and-manage/sme-booking) · `sme.akasaair.com/login` · `sme.spicejet.com` · `corporate.spicejet.com/agencyregistration.aspx`

**Gated — itself a finding**
- **Tripjack API docs** (`apidoc.tripjack.com` does not resolve publicly) · **TBO/TekTravels field docs**
  (account required) · **Sabre BFM full schemas** (developer account) · **Amadeus Enterprise API docs**
  (commercial agreement) · **all Indian airline corporate contract terms** (contract-only, no carrier
  publishes discount bands or minimum commitments)

**Raw research files:** `02-corporate-fares.md`, `raw-indigo-spicejet.md`, `raw-airindia-akasa.md`,
`raw-distribution.md`, `raw-platforms-gst.md` — in the session scratchpad under `scratchpad/research/`.
