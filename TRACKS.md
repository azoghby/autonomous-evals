# Two-agent implementation tracks

Based on the current GitHub PLAN.md (blob 989b907241581705281bcdc5202d5dd0341a6c5f), read November 7, 2026. The local PLAN.md may still describe the superseded USDC/Render architecture: use the GitHub plan as the implementation baseline. These tracks use Stripe, Next.js, Neon, and Vercel Workflow; no separate worker.

## Track A — Customer app, platform, payments, and deployment

Own the deployed customer journey and all infrastructure wiring.

1. Scaffold npm workspaces, TypeScript, Next.js in apps/web, and packages/core. Own root dependencies, lockfile, CI, environment template, and deployment configuration.
2. Configure Vercel, Neon application database, Drizzle migrations, private Blob storage, email magic-link authentication, and operator email allowlist. Provision AI Gateway configuration for Track B.
3. Build intake, clarification/quote, progress, report, and operator screens. Include trace uploads, endpoint configuration, ownership checks, real status/error states, downloads, finding reruns, and monitoring upsell.
4. Implement customer routes and idempotent mutations. Encrypt target credentials, enforce server-side ownership, and serve authorized private artifact downloads.
5. Implement jobWorkflow and its hooks/steps: clarification, payment wait, dispatch to Track B services, persisted milestones, report storage, notification integration, and recovery. Make Trace Audit a distinct path; it does not need endpoint calls or calendar scenario generation.
6. Implement Stripe Checkout, verified webhooks, payment records, retry-safe workflow resumption, reconciliation, live/test separation, and subscription billing if monitoring survives the scope cut. Persist a resumable payment signal before acknowledging a webhook; retry delivery safely across the database/external-workflow boundary.
7. Own all Vercel Cron routes/configuration: payment reconciliation, stale jobs, monitoring dispatch, follow-up scheduling, and cleanup. Track B supplies monitoring execution logic. Enforce credential deletion 24 hours and branch deletion 48 hours after delivery independently (not 72 hours from sequential sleeps).
8. Wire report/evidence uploads to Blob and the customer notification sender. Build outreach approval UI and enforce founder approval before sending outreach; Track B supplies drafts.
9. Own app/payment/access tests and the single browser happy-path smoke test. Deploy and verify the integrated flow; switch to live payment only after the plan's must-pass gates.

Owned files: apps/web/**, packages/core/src/db/**, packages/core/src/auth/**, packages/core/src/payments/**, packages/core/src/storage/**, root configuration and migrations. Own packages/core/src/contracts/** with input from B.

Done: a customer can sign in, submit a request, get a quote, pay, close the browser, return to a delivered report, export it, and request a linked retest. The operator can see payments, costs, decisions, and interventions. The deployed flow survives retries/redeploys.

## Track B — Naïve agents, evaluation engine, and reproducible findings

Own what the company does for a customer after intake.

1. Validate the Naïve SDK and four agent configurations: Commercial, Evaluation engineer, Quality investigator, Company operator. Require structured output and enforce session/agent/job budget caps. Persist usage, IDs, decisions, and results through shared database services.
2. Implement Commercial qualification, clarification and fixed-price quoting; outreach drafts; Operator reports, follow-ups, and monitoring pitches. Return structured results to A's workflow, with no independent orchestration framework.
3. Build Trace Audit first: extract success claims, associate evidence, detect unsupported claims/ignored errors/instruction violations, and have the investigator re-check findings. Preserve evidence and distinguish confirmed, rubric concern, and inconclusive.
4. Implement the secure target HTTP client and pre-payment connection check for A to call: HTTPS, DNS/private-address protections, no redirects, request timeout, bounded response, redacted credentials, and bounded concurrency.
5. Build Text Eval: 12 scenarios, investigator review, frozen suite, objective checks, AI Gateway rubric judgments, and up to three bounded reproductions. Missing reference text means factual correctness is not assessed.
6. Own simulator schema/fixtures and Neon branch lifecycle service: seed branch, per-job branch creation, run/version isolation, reset, and deletion. A provisions the Neon project and calls these functions from Workflow/cleanup. Provide simulator migrations separately from A's application migrations.
7. Build calendar tool loop and SQL state graders, six tool rounds maximum, two concurrent target calls, and buggy/fixed internal fixtures. Cover conflicts, duplicate booking, permissions, time zones, and false success after dependency failure.
8. Add version comparison with a shared frozen suite and separate version state. Implement rerun and monitoring evaluation functions; preserve original evidence. A owns UI, scheduling, billing, and email transport.
9. Return report Markdown/HTML, suite JSON, evidence, findings, and cost records for A to persist and display. After branch cleanup, retain exported evidence; a rerun must recreate isolated state from the frozen suite rather than depend on an expired branch.
10. Own engine, budget, malformed-output, target-security, simulator-isolation, and session-recovery tests. Exercise the real SDK path and demonstrate a known failure plus a corrected fixture.

Owned files: packages/core/src/agents/**, packages/core/src/evals/**, packages/core/src/targets/**, packages/core/src/simulator/**, packages/core/src/reporting/** and their tests/fixtures. Add simulator migrations under packages/core/src/simulator/migrations/**.

Done: the engine produces useful evidence-backed results via real Naïve sessions, respects budgets, handles malformed results and transient failures, and supplies deterministic fixtures and exports for the deployed app.

## First-hour agreement: unblock parallel work

- A creates the workspace and shared contracts first; B can immediately validate SDK sessions and develop trace fixtures in its owned directories.
- Agree on Zod inputs/outputs for intake, quote, clarification, scenario, execution, finding, report, progress event, and cost entry. Include job/customer IDs, package, quote version, live/test environment, and linked retest ID.
- Agree on service signatures for qualify, auditTrace, checkTarget, designSuite, runSuite, investigate, renderReport, createJobBranch, deleteJobBranch, and rerunFinding. Services return validated data; A's workflow decides sequencing.
- Database access, session persistence, budget reservations, and progress recording must use shared adapters. B specifies required fields; A owns application schema/migration edits. B supplies simulator schema independently.
- A creates realistic mock service responses conforming to contracts to build screens while B implements the services. Mock jobs must be labeled and must never count as customers, revenue, or completed live SDK verification.
- Each agent works on its own branch. Neither edits the other's owned files without a coordinated handoff. B requests dependency changes from A to prevent lockfile collisions. Contract changes are agreed before changing both callers and implementations.

## Integration gates and priorities

1. Deployed app + authenticated job + four schema-valid Naïve agents.
2. Unpaid fixture Trace Audit delivered through the real Workflow, stored evidence, and report UI.
3. Stripe test-mode paid Trace Audit; duplicate and missed webhooks recover without duplicate work.
4. Must-pass security, budget, payment, and redeploy/recovery checks, then a real customer payment and delivered finding.
5. Text Eval, calendar fixtures, then comparison and monitoring if time permits.

Cut order from the GitHub plan: comparison, then monitoring, then calendar simulator. Preserve real payment, evidence quality, and intervention logging. Feature freeze: November 8 at 9:30 AM Pacific; judging at 11 AM.

## Copy/paste agent assignments

**Agent A:** Read the latest GitHub PLAN.md and TRACKS.md. Implement Track A on your branch, owning the customer app, contracts, application schema, Stripe, Vercel Workflow, Blob, Cron, and deployment. Coordinate the first-hour contracts with Agent B. Start with a deployed intake-to-Trace-Audit-report path, then gate it with Stripe. Follow the ownership boundaries and integration gates; do not build Track B's engine yourself unless ownership is explicitly reassigned.

**Agent B:** Read the latest GitHub PLAN.md and TRACKS.md. Implement Track B on your branch, owning Naïve agents, Trace Audit first, then Text Eval, secure target calls, simulator/Neon branching, evidence, reports, and optional comparison/monitoring execution. Coordinate shared contracts/schema needs with Agent A. Export services for A's Workflow; A owns Vercel configuration, payment hooks, scheduling, UI, and deployment. Follow the ownership boundaries and integration gates.
