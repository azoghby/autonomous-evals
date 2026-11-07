# Autonomous Evals Company: Build Plan

Hackathon: Naïve Autonomous Company Hackathon, YC SF. Hacking runs Sat Nov 7, 1 PM to Sun Nov 8, 11 AM (judging).
Team: two builders. Budget: $250 Naïve credits plus sponsor credits.

---

## 1. Product and success criteria

An agent-operated evaluation company. Customers submit their agent, get an agent-written quote, pay, and receive an evidence-backed report, reproducible findings, and an exportable test suite.

Service menu (pilot pricing, clearly labeled):

| Package | Input needed | Price |
|---|---|---|
| **Trace Audit** | Paste/upload agent transcript or tool logs (JSON or text, ≤ 200 KB) | $5 |
| **Text Eval** | OpenAI-compatible endpoint + system prompt + optional reference text | $5 |
| **Workflow Eval** | Endpoint that supports tool calls; runs in our calendar simulator | $5 |
| **Version Comparison** | Two configs of either Text or Workflow Eval | $10 |
| **Monitoring pilot** (upsell) | Nightly re-run of the frozen suite via Vercel Cron, regression alert by email | $49/month (first payment collected via Stripe subscription) |

**Success by Sunday 11 AM:**

1. At least 3 independent teams completed intake (agent-run outreach or walk-up).
2. At least 1 real Stripe payment, not test mode, and at least 1 delivered report with a finding the customer confirms is real.
3. Operator console shows every agent decision, every founder intervention, revenue, and Naïve cost per job.

Test-mode payments are never counted as revenue.

---

## 2. Stack (Neon + Vercel first)

| Layer | Choice | Notes |
|---|---|---|
| App + API | **Next.js App Router on Vercel** (Fluid compute) | One repo, one deploy. `apps/web` only; shared code in `packages/core`. |
| Durable execution | **Vercel Workflow DevKit** (`workflow` package) | Workflows orchestrate; steps do I/O. Use `createHook` to pause for payment and clarification answers, `sleep` for timed follow-ups. |
| Database | **Neon Postgres** + Drizzle + `@neondatabase/serverless` driver | System of record for customers, jobs, quotes, findings, costs, interventions. |
| Isolation / repro | **Neon branching** via the Neon API | Seed branch `sim-seed` holds calendar fixtures. Each job forks `job-<id>`. Deleted 48 h after delivery. |
| Artifacts | **Vercel Blob** (private) | Reports (Markdown/HTML), JSON test-suite exports, raw evidence. |
| Model calls (judges, targets we host) | **Vercel AI Gateway** (OpenRouter as fallback) | One key, per-call cost logged to Neon. |
| Scheduled work | **Vercel Cron** | Stripe reconciliation every 5 min, stale-job sweep, nightly monitoring re-runs, follow-up nudges. |
| Agents | **`@usenaive-sdk/managed-agents`** | Required by the hackathon. Structured outputs, per-session budgets. |
| Payments | **Stripe Checkout + webhooks** | Live mode for the real charge; test mode for development. |
| Auth | Email magic link (Neon Auth if it sets up in < 30 min) | Job ownership enforced server-side. Operator access by email allowlist. |
| Validation / tests | Zod, Vitest | Playwright only for the single happy-path smoke test. |

Architecture in one line: browser → Next.js route handlers (Vercel) → `start(jobWorkflow)` → steps call Naïve sessions, AI Gateway, customer endpoints, and the Neon branch → results in Neon + Blob → progress page reads Neon.

---

## 3. Agents (Naïve)

Four agents, each with its own budget cap. The app's Workflow orchestrates them; agents propose and code decides.

| Agent | Does | Cannot |
|---|---|---|
| **Commercial** | Drafts outreach invites (sent only after founder approval), qualifies inbound requests, asks clarifying questions, picks a package, writes the quote from the fixed price table, pitches the monitoring upsell in reports | Invent prices or deliverables, send email without approval |
| **Evaluation engineer** | Writes 12 scenarios plus scoring criteria per version as schema-valid JSON; revises rejected tests | Execute code, touch credentials |
| **Quality investigator** | Rejects invalid tests before freeze, reviews evidence, requests up to 3 bounded reproductions, classifies findings | Override an objective state check without filing a test-defect record |
| **Company operator** | Decides job readiness, writes the final report, answers follow-ups, proposes retests, writes a short daily ops log | Change budgets, issue refunds |

Every session uses `output_schema` + `structured_output_required` + an explicit `budget_micro_usd`. Store agent ID, version, session ID, result, and usage in Neon immediately; a session ID is persisted in the same step that creates it. An idle session is not a success: always check the result against the schema.

Use Naïve **identity** (email) for the Commercial agent's inbox so customer replies land with the agent, not with you.

**Stretch:** run the four as a Naïve **team** with the operator as coordinator. Only do this if the app-orchestrated version is done by midnight.

---

## 4. Evaluation modes

### 4.1 Trace Audit (zero integration; build first)

The customer pastes a transcript or tool log. The engine reuses agent-verdict's logic:

- Extract every claim of success ("booked", "sent", "fixed", "tests pass").
- Match each claim to evidence in the log (a tool call, its result, an error).
- Flag unsupported claims, ignored tool errors, instruction violations against the stated system prompt, and unsafe actions.
- Investigator re-checks each flagged item; output is "confirmed", "rubric concern", or "inconclusive".

No outbound calls to the customer, so there is no SSRF risk and no credential handling. This is the fastest path to a paid, delivered job.

### 4.2 Text Eval

- 12 scenarios: ordinary use, instruction edge cases, grounding/ambiguity.
- Freeze the suite after investigator review, and store it in the job's Neon branch.
- Code checks for explicit constraints; rubric judges (via AI Gateway) for subjective quality, labeled as such.
- No reference text means factual correctness is reported as "not assessed".
- Repeat up to 3 candidate failures once to confirm.

### 4.3 Workflow Eval (calendar simulator on Neon)

- Simulator tables (`events`, `calendars`, `permissions`, `tool_calls`) live in the `sim-seed` branch with fixtures.
- Each job forks a branch. Each scenario runs inside its own transaction plus `run_id` partition, reset by deleting that `run_id`, so scenarios never see each other's state.
- Tools: `list_events`, `create_event`, `update_event`, `cancel_event`. Times stored as UTC with explicit IANA zone.
- Max 6 tool rounds per scenario, 30 s per target request, 2 concurrent target requests.
- Coverage: booking, conflicts, duplicates, cancellation, rescheduling, time zones, permissions, one injected dependency failure (to catch "false success").
- Grading is SQL over the resulting state: event counts, owners, times, permitted changes, and whether claimed actions actually happened.
- Two internal fixture agents (buggy and fixed) are clearly labeled and never counted as customers.

### 4.4 Version Comparison

Same frozen scenarios, separate `run_id`s per version in the same job branch. Report shows observed differences only, with no significance claims on 12 scenarios.

### Reproduction

Every finding links to the job's Neon branch and the scenario ID. "Re-run this finding" replays it against the customer's current endpoint; the original result is kept. That's the retest flow, and the hook for the monitoring tier.

---

## 5. Customer flow, payments, security

Screens (Tailwind, IBM Plex Sans, one teal accent, real loading/empty/error states, no fake logos):

1. **Intake:** pick a package, paste trace or endpoint config, confirm authorization to test.
2. **Clarify + quote:** chat with the Commercial agent; quote shown from the fixed table.
3. **Progress:** live milestones read from Neon (poll every 3 s; SSE if time allows).
4. **Report:** findings, evidence, export (Blob link), "Re-run finding", monitoring upsell.
5. **Operator console:** jobs, Stripe payments, Naïve cost per job, agent decisions, intervention log, outreach approval queue.

**Payments (Stripe):**

- Accepting a quote freezes scope and creates a Checkout Session with `job_id` and `quote_version` in metadata.
- The Workflow pauses on a hook. The Stripe webhook (signature verified) resumes it.
- The webhook handler writes `payments` (unique on Stripe event ID) and resumes the job in one idempotent step, so duplicate webhooks can't double-start a job.
- Vercel Cron reconciles open Checkout Sessions every 5 min in case a webhook is missed.
- Refunds are done manually by a founder in the Stripe dashboard and logged as an intervention.

**Endpoint connection check** (Text/Workflow): one minimal request before payment, with a note that it may use the customer's provider credits.

**Security:**

- Customer credentials encrypted at rest in Neon, never put in agent prompts or logs, deleted 24 h after delivery.
- Outbound target calls: HTTPS only, block private/reserved IPs (check at DNS resolution), no redirects, bounded response size.
- Customer content is untrusted data; generated tests are JSON, never executed code.
- Every API mutation takes an idempotency key; job reads are checked against owner email.

---

## 6. Durable execution: one Workflow per job

```
jobWorkflow(jobId)            "use workflow"
  step clarifyAndQuote        → Commercial session(s); hook waits for customer replies
  hook awaitPayment           → resumed by Stripe webhook or Cron reconciliation
  step createJobBranch        → Neon API: fork sim-seed → job-<id>
  step designSuite            → Engineer session → Investigator review → freeze
  step runScenarios           → per scenario (bounded parallelism 2)
  step investigate            → Investigator, up to 3 reproductions
  step writeReport            → Operator session → Blob + Neon
  step notifyCustomer         → email via Commercial agent identity
  sleep 24h → step cleanupCredentials ; sleep 48h → step deleteBranch
```

States in Neon: `draft → needs_clarification → quoted → awaiting_payment → planning → running → investigating → delivered`, plus `payment_review`, `paused_budget`, `failed`, `cancelled`. Retest = new linked job.

Rules:

- Each step writes its result to Neon before returning, so the console never depends on Workflow internals.
- Naïve session creation is its own step. If its result is ambiguous, look the session up by stored ID instead of creating a second one.
- Budget is reserved in Neon before each session; exhaustion moves the job to `paused_budget` and alerts the operator, with no hidden retries.

---

## 7. Budgets and honest accounting

Naïve agent period caps (total $200, $50 unallocated): Commercial $35, Engineer $65, Investigator $65, Operator $35.
Per-job caps: $3 for single-version, $5 for comparison, reserved before dispatch.

The console tracks three columns separately: **revenue** (live Stripe only), **known costs** (Naïve usage plus AI Gateway usage per job), and **unknown costs** (customer's own provider usage, hosting). Never label anything "profit" when costs are incomplete.

---

## 8. Wall-clock schedule (two builders)

| Time | Builder A (app, Neon, Stripe, Vercel) | Builder B (agents, evals) | Gate |
|---|---|---|---|
| **1–2 PM** | Scaffold Next.js on Vercel, Neon project + Drizzle schema, Blob, auth | Naïve key works; one structured-output session per agent | Deployed URL; 4 agents return valid JSON |
| **2–2:30 PM** | Both walk the room: tell teams about free first audits; collect emails | Same | 10+ team contacts in Neon |
| **2:30–5 PM** | Intake, quote, progress screens; `jobWorkflow` skeleton with hooks | **Trace Audit** engine + investigator + report | Unpaid Trace Audit delivered end to end |
| **5–7 PM** | Stripe Checkout + webhook + Cron reconciliation | Text Eval runner; AI Gateway judges | Test-mode paid job delivered |
| **7–7:30 PM** | **Switch Stripe to live; run first real customer** | Commercial agent outreach drafts + approval queue | First real payment |
| **7:30–11 PM** | Operator console: costs, interventions, approvals | Calendar simulator on Neon branches + state graders | Buggy fixture fails, fixed fixture passes |
| **11 PM–1 AM** | Report page polish, Blob exports, re-run finding | Version comparison; monitoring Cron | Comparison job delivered |
| **1–5 AM** | Sleep (A) | Customer support shift: watch jobs, fix false positives | No stuck jobs |
| **5–8 AM** | Customer support shift | Sleep (B) | |
| **8–9:30 AM** | Bug fixes from real customers | Bug fixes; monitoring upsell pitch in reports | **Feature freeze 9:30 AM** |
| **9:30–11 AM** | Record backup demo video; final numbers | Rehearse demo twice | Ready for judging |

If behind schedule, cut in this order: version comparison → monitoring Cron → calendar simulator (Trace Audit plus Text Eval alone still make a complete company). Never cut real payment, evidence quality, or the intervention log.

---

## 9. Tests and demo

**Must-pass checks:**

- Payments: valid webhook; bad signature rejected; duplicate webhook doesn't create a second job; missed webhook recovered by Cron.
- Durability: redeploy mid-job; job resumes from last finished step; no duplicate Naïve sessions.
- Evals: known instruction failure detected; unsupported success claim caught in a trace; buggy fixture fails, fixed one passes; malformed judge output rejected.
- Security: other users can't read your job or Blob artifacts; credentials absent from prompts/logs; private-IP target blocked.
- Budgets: exhausted cap pauses the job.

Only after these pass do you take money from a real customer.

**Demo script (3 minutes):**

1. Operator console: "Since 1 PM our agents contacted N teams, ran M jobs, made $X real revenue, spent $Y on Naïve, and I stepped in K times, here's each one."
2. Replay one real customer job: inquiry → agent clarification → quote → Stripe payment → workflow progress → report.
3. Open one finding, click "Re-run": it reproduces live on its Neon branch.
4. Close with the monitoring tier and the market: eval platforms sell tools; this company does the work itself.

Backup: pre-recorded video of the same flow in case the venue Wi-Fi fails.

---

## 10. Out of scope this weekend

USDC payments (stretch only if everything else ships), smart-account wallets, mainnet chain reconciliation, automated refunds, Naïve team-coordinator orchestration, Mobilerun mobile evals, Vercel Sandbox for running customer repos, statistical significance claims, scraping-based prospecting.
