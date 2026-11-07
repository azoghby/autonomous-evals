# Autonomous Evals Company: Implementation Plan for Tomorrow

Planning baseline: November 7, 2026. Two builders; $250 in Naïve credits. Target demo: November 8, 2026, before 11 a.m. Pacific judging.

## 1. Product and stack

Build an agent-operated evaluation company with a broad service offering and two working evaluation modes:

- **Text evaluation:** assess answers against customer instructions and supplied reference material.
- **Workflow evaluation:** test a tool-using agent inside our controlled calendar simulator.
- **Version comparison:** run either evaluation mode against two versions using identical scenarios and initial conditions.

Customers submit a product, receive an agent-prepared quote, pay in USDC, and receive a report, reproducible findings, and an exportable test suite. Agents handle clarification, planning, investigation, delivery, and retest requests.

**Success tomorrow:** an independent hackathon team completes the paid workflow, receives a useful finding, and can reproduce it. Show actual costs and every founder intervention. Testnet transactions are never counted as revenue.

### Chosen stack

| Layer | Choice |
|---|---|
| Language/runtime | TypeScript, Node.js 22, npm workspaces |
| Customer application | Next.js App Router, React, Tailwind CSS, Vercel |
| Persistent worker | Node.js service on Render; PostgreSQL-backed work queue |
| Database | Neon PostgreSQL with Drizzle ORM and migrations |
| Agents | `@usenaive-sdk/managed-agents` |
| Validation | Zod; JSON Schema for agent outputs |
| Wallet integration | Wagmi and Viem; injected EVM wallets |
| Payments | Native USDC on Base and test USDC on Base Sepolia |
| Reports/artifacts | Markdown and JSON stored in PostgreSQL; authenticated downloads |
| Testing | Vitest and Playwright |

Use one repository with `apps/web`, `apps/worker`, and `packages/core`. Shared contracts, database access, evaluation types, and payment configuration live in `core`.

Vercel handles short requests and UI. Render handles long evaluations, payment reconciliation, and recovery. No evaluation depends on an open browser or a long-running Vercel request.

Naïve's published SDK is TypeScript and ESM-only; use its documented client rather than implementing a separate model-driven agent runtime. [SDK documentation](https://usenaive.ai/docs/sdk/typescript)

## 2. Agents and evaluation engine

### Four Naïve agents

| Agent | Output and authority |
|---|---|
| **Commercial** | Qualifies requests, requests clarification, selects a supported package, and prepares quotes within fixed pricing rules |
| **Evaluation engineer** | Produces structured scenarios and scoring criteria; revises tests rejected during review |
| **Quality investigator** | Reviews test validity, investigates evidence, requests bounded reproductions, and classifies findings |
| **Company operator** | Assesses job readiness, coordinates revisions, prepares the final report, answers follow-up questions, and proposes retests |

For tomorrow, the persistent application orchestrates specialist sessions through the SDK. Do not add nested agent delegation or a second coordination framework.

Each session receives a bounded task and must return schema-valid output. Store agent ID, version, session ID, result, and available usage data. Use `sessions.create`, explicit `budget_micro_usd`, `output_schema`, and `structured_output_required`; read results through `sessions.get`. An idle session is not automatically a successful session. [Session interface](https://usenaive.ai/docs/sdk/sessions)

Use `vetta/auto` for the initial configuration, recording the selected configuration with each run. Keep customer credentials and arbitrary shell/browser tools out of agent sessions.

**Division of responsibility:** agents propose plans and make bounded decisions; application code validates them and executes state changes, HTTP calls, payments, and scoring rules.

### Target integration contract

Support one protocol tomorrow: **OpenAI-compatible Chat Completions over HTTPS**, with optional bearer authentication.

Customers supply:

- Endpoint and model identifier.
- System instructions and evaluation goals.
- Optional reference text, limited to 100 KB.
- A second target configuration for comparison.
- Confirmation that they control or are authorized to test the endpoint.

A pre-payment connection check makes one minimal request and validates the response. Explain that this request may consume the customer's provider credits.

For workflow evaluation, the endpoint must support standard function/tool calls. Provide a sample adapter and two clearly labeled internal fixture agents: one buggy, one corrected. External customers must be identified separately from these fixtures.

### Text evaluation

Generate **12 scenarios** distributed across ordinary use, instruction edge cases, and grounding or ambiguity.

- Review and freeze the test suite before full execution.
- Use code-based checks for explicit constraints.
- Use rubric-based model judgments for subjective quality, clearly labeled as such.
- Treat absent references as a limit on factual-correctness assessment.
- Repeat up to three candidate failures once.
- Distinguish confirmed failures, rubric-based concerns, infrastructure errors, and inconclusive results.

Never present a model's confidence score as a calibrated probability.

### Calendar workflow evaluation

Implement an isolated calendar environment with these tools:

- `list_events`
- `create_event`
- `update_event`
- `cancel_event`

Each scenario receives a fresh, private calendar state. Store times as UTC timestamps with explicit IANA time zones.

The worker sends tool definitions to the target, validates returned arguments, executes calls against the simulator, and continues the conversation. Limit each scenario to **six tool rounds**.

Cover booking, conflicts, duplicate requests, cancellation, rescheduling, time-zone handling, permissions, and one simulated dependency failure.

Grade against actual resulting state: event counts, ownership, expected times, permitted changes, and whether claimed actions occurred. The investigator may explain evidence but cannot override an objective result without recording a test defect.

Comparison jobs reuse the same frozen scenarios and reset state independently for both versions. Reports describe observed results without claiming statistical significance from a small sample.

## 3. Customer flow, payments, and durable operation

### Customer access and screens

Use wallet-based sign-in with a single-use, domain-bound, expiring message challenge. Support externally owned EVM wallets for tomorrow; smart-account compatibility is deferred.

Provide five screens:

1. **Service/intake:** supported packages and target configuration.
2. **Clarification/quote:** conversation, scope, limits, price, and payment network.
3. **Job progress:** real milestones, decisions, and recoverable errors.
4. **Report:** findings, evidence, test-suite export, and retest request.
5. **Operator console:** jobs, receipts, costs, session activity, and intervention log.

Customer authorization is enforced server-side by wallet identity and job ownership. Operator access uses an environment-configured wallet allowlist.

Use a restrained operational interface: warm neutral surfaces, dark text, one teal accent, IBM Plex Sans typography, compact tables, and a chronological activity feed. Include keyboard navigation and real loading, empty, error, and payment-pending states. No fabricated customer logos or performance metrics.

### Pricing and quote rules

Label pricing as **hackathon pilot pricing**:

- Text or workflow evaluation: **5 USDC**.
- Two-version comparison: **10 USDC**.
- Each includes 12 scenarios per version, bounded reproductions, report, and test-suite export.
- A retest creates a new scoped quote at the applicable pilot price.
- Unsupported requirements are declined or clarified before payment.

The commercial agent can select and explain these packages, not invent prices or unlimited deliverables.

### Stablecoin payment implementation

Implement **direct ERC-20 wallet transfers**, without escrow, a custom contract, x402, fiat conversion, or server-held spending keys.

Maintain separate Base and Base Sepolia configurations. Resolve native USDC addresses from Circle's official deployment list and pin them in configuration; do not accept arbitrary token addresses or bridged substitutes. [Circle contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

For each accepted quote, create an immutable invoice containing:

- Job, customer wallet, quote version, and environment.
- Chain ID, token address, company recipient address.
- Exact amount in six-decimal token units.
- Creation block and 30-minute expiry.

The browser switches networks, requests the transfer, and submits the transaction hash. Customers need USDC and native gas; show both requirements before checkout.

The backend independently verifies:

- Correct chain and successful receipt.
- Direct call to the configured USDC contract.
- Expected sender, recipient, amount, and matching transfer event.
- Inclusion after invoice creation and before expiry.
- Two block confirmations before execution.
- Unique consumption of the transfer using a database constraint on chain, transaction hash, and log index.

Two confirmations are an operational threshold, not a claim of irreversible finality. Recheck receipts during reconciliation; flag a removed payment and pause further work.

Wrong or late payments enter a visible review state. Never silently discard received money or start unbounded work. Refunds require a founder's wallet transaction tomorrow; record the reason and refund reference.

Marking an invoice paid and creating its execution task occur in one database transaction. Repeated submissions cannot create duplicate jobs.

Mainnet is enabled only after successful testnet checks and explicit recipient configuration. Both environments remain visibly labeled and separated.

### Job lifecycle and recovery

Use:

`draft → needs_clarification → quoted → awaiting_payment → planning → running → investigating → delivered`

Additional states: `payment_review`, `paused_budget`, `failed`, and `cancelled`.

A new retest is a linked job, preserving the original report.

Use a PostgreSQL work queue with leases, heartbeats, bounded retries, and an outbox:

- Persist work before external calls.
- Store Naïve session identifiers immediately.
- Resume known sessions after restart.
- Retry transient reads and target transport failures within limits.
- Do not blindly recreate sessions after an ambiguous creation timeout; reconcile or escalate.
- Record each phase result before starting the next.
- Poll sessions for tomorrow's implementation; signed webhooks are not a dependency.

Start with one active job and two concurrent target requests. Each target request has a 30-second timeout and bounded output.

### Budgets and records

Allocate **200 USD-equivalent Naïve credits** across agent period caps:

- Commercial: $35.
- Evaluation engineer: $65.
- Quality investigator: $65.
- Company operator: $35.

Leave $50 unallocated. Enforce aggregate per-job authorization caps of **$3 basic / $5 comparison**, reserving session budgets before dispatch. No automatic budget increases. Naïve also enforces its own session and agent caps. [Budget documentation](https://usenaive.ai/docs/concepts/budgets)

Track customer revenue separately from subsidized credit consumption. Report known costs, estimates, and unknown customer-provider costs separately; incomplete accounting must not be labeled profit. Hosting and RPC expenses are outside the Naïve credit allocation.

### Minimum persistent types and interfaces

Store customers, targets, jobs, messages, quotes, invoices, transfers, agent sessions, scenarios, executions, findings, artifacts, tasks, cost entries, and intervention events.

Expose:

- `POST /api/jobs` — create intake.
- `POST /api/jobs/:id/messages` — clarification or support.
- `POST /api/jobs/:id/accept-quote` — freeze scope and issue invoice.
- `POST /api/jobs/:id/payment` — submit transaction for verification.
- `GET /api/jobs/:id` — progress and decisions.
- `GET /api/jobs/:id/report` — authorized report/export.
- `POST /api/jobs/:id/retest` — create linked inquiry.

All mutations use idempotency keys. The worker shares validated service functions rather than calling public customer routes.

Encrypt stored target credentials, redact secrets from traces, and never expose them to agents. Target calls use a fixed HTTPS destination, block private/reserved addresses and redirects, and validate DNS resolution at connection time. Customer content is untrusted data; generated test plans cannot execute arbitrary code. Delete stored target credentials 24 hours after delivery.

## 4. Build order and two-person ownership

**Build the evaluation-to-report path first. Payment then unlocks that proven path.**

| Time from start | Builder A: application/payments | Builder B: agents/evaluations | Acceptance gate |
|---|---|---|---|
| **0–1 hour** | Scaffold web/core, Neon schema, wallet access | Validate Naïve credentials, run one structured-output session | Shared contracts compile; one SDK session completes |
| **1–4 hours** | Intake, ownership, job records, progress screen | Text runner, engineer/investigator sessions, initial report | One fixture produces a reproducible finding |
| **4–7 hours** | Testnet invoice, transfer verification, transactional task creation | Calendar simulator, tool-call loop, state graders | Paid testnet job runs through delivery |
| **7–10 hours** | Report exports, console, mainnet configuration | Comparison, recovery, cost accounting, operator delivery | Browser closure/restart does not lose the job |
| **10–13 hours** | External onboarding and payment support | Adapt authorized customer endpoint; inspect false positives | External team receives useful results |
| **Remaining time** | Customer fixes, checkout polish, recording | Retest, acceptance checks, demo preparation | Freeze before Nov. 8's 11 a.m. judging |

During the first hour, both founders invite nearby teams to try the service. Agents handle submitted inquiries and follow-up in the application. Automatic outbound messaging, email-domain setup, and public prospect scraping are excluded tomorrow.

If integration runs late, reduce exploratory scenario volume and UI polish. Preserve payment verification, both evaluation paths, evidence quality, recovery, and honest status reporting.

## 5. Verification and demo acceptance

### Required tests

- **Payments:** valid testnet transfer; wrong chain/token/sender/recipient/amount; reverted, expired, duplicate, and unconfirmed transfers; concurrent submissions; restart during reconciliation.
- **Durability:** restart between every major phase; no duplicate delivery or charge attribution; ambiguous session creation escalates.
- **Text evals:** known instruction failure detected; unsupported factual judgment marked limited; malformed judge output rejected.
- **Workflow evals:** duplicate booking, wrong time zone, unauthorized cancellation, false success after tool failure; corrected fixture passes the relevant checks.
- **Quality:** deliberately invalid generated test rejected; findings preserve evidence and reproduction results.
- **Access/security:** another customer cannot read jobs or artifacts; credentials stay out of prompts/logs; private-network targets and redirects are blocked.
- **Budgets:** exhausted session/job budget pauses work without hidden retries.
- **UI:** desktop and mobile intake-to-report flow, wallet rejection, wrong network, pending payment, failed target, and retest.

Perform one small mainnet payment only after testnet acceptance. Live external evaluation and the actual Naïve SDK path must be exercised; mocked tests alone are insufficient.

### Final demonstration

Show an external inquiry, agent-produced scope, customer-authorized USDC payment, automatic execution, evidence-backed delivery, and a retest if available. Display decisions and founder interventions alongside revenue and costs.

**Explicit boundaries:** no claims of universal coverage, statistical certification, fully automated refunds, agent-paid model bills, or validated startup economics. Tomorrow proves one working autonomous commercial cycle; repeat demand and scalable margins remain the next experiments.
