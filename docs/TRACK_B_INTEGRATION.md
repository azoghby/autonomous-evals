# Track B integration and acceptance

Status: implementation in progress. This document specifies integration requirements, not completed capabilities. PLAN.md is the product baseline; TRACKS.md sets ownership. Track A owns app/platform configuration and application database migrations. Track B owns engine services and simulator migrations.

## Integration boundary

Track B exports TypeScript services for Track A's Workflow steps. It does not start a second job orchestrator, call public customer routes, send outreach, collect payments, or manage Vercel configuration.

The first deliverable is Trace Audit. It accepts a bounded transcript plus optional system instructions, returns evidence-linked findings and report artifacts, and does not require a customer endpoint or simulator branch. Text and calendar evaluations follow.

Service names and exact imports will be recorded here after integration. Do not implement against speculative signatures. The agent implementation notes will live in `docs/track-b-agents.md`; target/simulator implementation notes in `docs/track-b-targets.md`.

### Persistence supplied by Track A

- Authorize the job/customer before invoking engine services. Customer input must not choose another customer's job ID, credential reference, branch, or run.
- Supply durable session records and atomic budget reservations. Persist intent before session creation and persist returned IDs immediately; recover known sessions rather than recreating them.
- An ambiguous create response without a session ID is a reconciliation/manual-review condition. A database transaction cannot make an external provider call atomic. Never retry creation simply because no session ID was saved.
- Store phase outputs before advancing, including frozen suites, executions, findings, costs, report references, and intervention records. Repeated Workflow steps must reuse durable results or idempotent operations.
- Reserve against the aggregate job cap before every agent dispatch. Job caps are $3 single-version and $5 comparison; reservations must hold under concurrent calls. Unknown usage is not zero cost.
- Provide decrypted target credentials only to the transport layer. Never pass them to agent prompts, findings, logs, or exported artifacts.

### Infrastructure supplied by Track A

- Naïve SDK authentication and four configured agent identifiers/versions, with period caps of $35 Commercial, $65 Engineer, $65 Investigator, and $35 Operator.
- AI Gateway configuration for subjective judges and hosted fixtures. Record judge usage separately from Naïve usage and unknown customer-provider costs.
- Neon application storage plus a simulator seed branch. Track B supplies simulator schema and branch lifecycle functions; Track A supplies project authorization and invokes cleanup.
- Private artifact persistence and authorized downloads. Do not expose database connection URLs or raw branch credentials in customer reports.
- Credential deletion 24 hours after delivery and simulator branch deletion 48 hours after delivery, independently scheduled. Frozen suites and evidence survive branch deletion; reruns recreate isolated state.

## Acceptance evidence required before claiming Track B complete

| Area | Required evidence |
| --- | --- |
| Naïve integration | Real structured-output session for each of the four roles; IDs, versions, result validation, and usage recorded. Mocks alone do not pass. |
| Trace Audit | A transcript containing a false success claim yields a finding tied to the actual claim and tool evidence; successful and ambiguous traces do not become invented confirmed failures. Investigator recheck is exercised. |
| Input handling | Text/JSON limits, malformed input, untrusted instructions, and output-schema failures are handled without executing customer content. |
| Commercial | Fixed $5/$10 pilot quotes, clarification for unsupported scope, no invented deliverables, and outreach remains draft-only until approved by a founder. |
| Text Eval | Twelve reviewed/frozen scenarios, explicit code checks, labeled rubric judgments, no-reference factual limitation, and at most three candidate failures repeated once. |
| Target transport | Tests cover private/reserved IPv4/IPv6, mapped addresses, mixed DNS answers, rebinding, redirects, timeouts, response limits, malformed completions, and secret redaction. |
| Calendar | Buggy/fixed fixtures distinguish conflicts, duplicates, cancellation/rescheduling, permissions, time zones, and false success after tool failure. SQL adapter and state grading are exercised against PostgreSQL, not only an in-memory substitute. |
| Isolation | Scenarios and versions cannot read or mutate each other's calendar state; reset/replay preserves original execution evidence. |
| Bounds | Six tool rounds maximum, two concurrent target requests, 30-second target timeout, bounded reproductions, and budget exhaustion pauses without hidden retry spending. |
| Recovery | Restart after session creation and between phases does not duplicate sessions or reports; ambiguous creation is explicitly escalated; concurrent budget reservations cannot exceed the cap. |
| Artifacts | Findings link to scenario/evidence IDs; Markdown/JSON exports are valid, optional HTML is escaped, credentials are absent, and small comparisons make no statistical-significance claims. |
| Live path | An authorized external endpoint and real Naïve SDK are exercised. Clearly separate external customer evidence from internal fixtures. |

## Scope sequencing

1. Trace Audit and real Naïve sessions, integrated with Track A's unpaid job-to-report path.
2. Text evaluation and secure connection checks, then paid end-to-end integration owned by Track A.
3. Calendar simulator and reproducible findings.
4. Comparison and monitoring execution when the earlier gates pass.

The plan permits cutting comparison, monitoring, then calendar if necessary, but a cut must be reported explicitly rather than marked implemented. Track B completion claims must distinguish implemented/tested services, live-provider checks, and Track A integration still pending.
