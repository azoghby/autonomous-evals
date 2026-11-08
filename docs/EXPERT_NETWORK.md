# Expert Network: agents gather industry data from professionals

Status: **proposed scope addition** (Nov 7). It runs after the PLAN.md integration gates: real payment, then Trace Audit, then Text Eval. It sits between Text Eval and the calendar simulator in priority. Cut it before cutting real payment, evidence quality or the intervention log.

## Why

An eval is only as good as its ground truth. A customer may send a domain agent: legal intake, clinical triage, insurance claims, accounting. Our agents can write the scenarios, but they can't say with authority what "correct" looks like in that domain. A Mercor-style expert network closes the gap. Our agents find working professionals, ask them targeted questions (async or on a short call), pay a fixed honorarium, and turn the answers into reference text, rubric items and finding adjudications. Each answer keeps its provenance.

This is also a demo point: the company's agents are hiring humans for the parts that need human judgment.

## What the agents can do

| Capability | Who | Notes |
|---|---|---|
| Detect a need for expertise | Evaluation engineer, Quality investigator (Track B) | Emits `ExpertRequest {domain, questions[], purpose, jobId?, maxBudgetCents}` as structured output. Code decides whether it's allowed. |
| Match against our opt-in pool | Code (Track A) | `experts` table, filtered by domain, availability and rate. |
| Propose new contacts | Commercial agent + Monid enrichment | Only individually researched, publicly listed professional contacts. Each one is a **draft** in the existing outreach approval queue. No bulk lists. |
| Send outreach | Code, after **founder approval** | Sent from the Commercial agent's Naïve identity inbox, so replies reach the agent. Resend is the fallback. |
| Run async questions | Code + agents | A tokenized questionnaire page `/expert/r/<token>` collects structured answers. |
| Schedule a call | Commercial agent proposes, code books it | Free/busy and booking go through Google Calendar (Vercel Connect OAuth or the Calendar integration), with a Meet link. |
| Turn calls into data | Investigator (Track B) | Recorded only with explicit consent. The transcript is stored in Neon and Blob, and structured insights are extracted with quotes. |
| Use the data | Engineer and Investigator | Reference text, rubric criteria and finding adjudication, each labeled **expert-sourced**. |

**Stretch:** an AI voice interviewer for short structured calls, which says up front that it is an AI. This happens only if every other part ships.

## Flow

```
ExpertRequest (agent) ─▶ policy check (budget, customer consent, rate limit)
   ├─ pool match ─▶ invite (approval if first contact) ─▶ questionnaire | call booking
   └─ no match   ─▶ Commercial drafts N≤3 cold intros ─▶ founder approves each ─▶ send
reply/answer ─▶ expert_responses (Neon) ─▶ Investigator extracts insights ─▶ suite/rubric/report
honorarium owed ─▶ operator pays manually ─▶ logged as intervention + cost
```

## Guardrails (non-negotiable)

1. **Founder approval** before any first-contact email. This is already a PLAN.md rule for outreach. Follow-ups within an engagement the expert accepted can be automatic.
2. **Honest identity.** Messages say they come from Autonomous Evals, that an AI agent wrote them, and what the data is used for. No pretexting, and no fake human personas.
3. **Opt-out and suppression.** Every email has a one-click opt-out that writes to a global `contact_suppressions` table checked before every send. Messages are CAN-SPAM compliant: sender identity, physical address, honest subject.
4. **No scraped lists.** PLAN.md §10 keeps scraping-based prospecting out of scope. New contacts are individually researched public professional profiles, at most 10 cold contacts a day, each one approved.
5. **Customer confidentiality.** Customer traces, prompts and findings are never shown to experts unless the customer opted in at intake ("Allow vetted domain experts to review anonymized excerpts"). Without opt-in, experts only answer generic domain questions.
6. **Consent for recording,** captured on the booking form and again at the start of the call. Without consent, notes are taken but the call isn't recorded.
7. **PII minimization.** Expert contact details live in `experts`. Anything shown to agents uses `expert_id` and role only. Name attribution in reports requires explicit consent.
8. **Budgets.** Each honorarium reserves budget like an agent session does. Per-job expert spend is capped (default $0 unless the package or operator allows it). Honoraria are paid manually in the pilot, so they're logged, not automated.

## Data model (Track A, Neon)

- `experts`: id, email, name, title, organization, domains[], profile_url, source (`opt_in` | `customer_nominated` | `agent_researched`), rate_cents, consent_flags, status, created_at.
- `expert_requests`: id, job_id?, domain, questions jsonb, purpose, max_budget_cents, status, requested_by_agent_session.
- `expert_engagements`: id, request_id, expert_id, mode (`async` | `call`), token_hash, scheduled_at, calendar_event_id, recording_consent, honorarium_cents, paid_at, status.
- `expert_responses`: id, engagement_id, answers jsonb, transcript_blob_path, insights jsonb, provenance.
- `contact_suppressions`: email (lowercased, unique), reason, created_at.

A Neon trigger or app code moves `expert_requests.status` forward when a response lands. The operator console updates through Neon Realtime if that is adopted; see the Neon/Vercel section in TRACK_A_PLAN.md.

## Screens (Track A)

- `/experts`: a public opt-in page ("Get paid to review AI agents in your field"). Collects profile, domains, rate, availability and consents.
- `/expert/r/[token]`: the questionnaire or booking page for a single engagement.
- Operator console tab **Experts**: requests, approval queue (it reuses `outreach_drafts`), engagements, honoraria owed and paid, and opt-outs.

## Contact research via Monid (verified Nov 7)

`MONID_API_KEY` is set on Vercel and in local env, and the account balance is $20. These are the relevant endpoints, found with `monid discover`:

| Provider | Endpoint | Use | Price |
|---|---|---|---|
| contactout | `/v1/people/search/work-email` | Find professionals by title, company or skills, with a work email | from $0.02 per result |
| contactout | `/v1/people/enrich/work-email` | Enrich one known profile | from $0.02 per call |
| tendata | `/v2/contact` | People at a company, filtered by role | $0.08 per result |

Rules: work emails only, never personal ones. Search for at most 10 candidates per expert request. Every candidate becomes an approval-queue draft, never an automatic send. Each Monid run's cost is recorded in `costs` with source `monid`.

## Ownership

- **Track A:** tables and migrations, opt-in and questionnaire pages, approval queue, email transport, calendar booking, suppression list, rate limits, operator UI, honorarium logging.
- **Track B:** the `ExpertRequest` schema in the agents' structured outputs, draft generation, contact research via Monid, insight extraction, and use of expert data in suites and reports with provenance labels.
- The contract (`ExpertRequest`, `ExpertInsight`) is added to `packages/core/src/contracts/` by agreement.

## Phasing

1. **MVP (tonight, about 2–3 h of Track A work):** opt-in page, tables, async questionnaire, approved email outreach through the existing queue, operator tab.
2. **Calls:** Google Calendar booking and a consent-gated transcript upload.
3. **Stretch:** a disclosed AI voice interviewer and agent-researched contacts at volume (still approval-gated).

## Open questions for the founders

- Honorarium amounts: suggested $25 for an async questionnaire and $75 for a 15-minute call. Paid how? Manual Stripe/PayPal for the pilot.
- Which domains to seed the pool with at the hackathon? The people in the room are a natural first pool.
- Should we run outreach through Mercor's own platform if they offer a partner or API route? None is known; for now this is "Mercor-style" and built in-house.

## Current automation policy update

Alex selected automatic contact for opted-in experts and approval for new cold contacts. This supersedes the blanket first-contact rule above only for opted-in experts. Pilot honorarium caps are $25 per evaluation and $50 company-wide per day, with durable reservation before commitment; payouts remain manual. The connection between acquisition, invitations, independently reviewed contributions and evaluation resumption is tracked in [expert-automation-progress.md](expert-automation-progress.md). Do not treat the older interface inventory or the new core adapter as deployed end-to-end acceptance.
