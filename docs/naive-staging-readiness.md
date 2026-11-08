# Naïve staging readiness and acceptance

This is a setup and acceptance checklist, not a completed live gate. It reflects the adopted expert text source and `docs/NAIVE_PLAN.md`, with newer source/adoption receipts taking precedence over that plan's historical status tables. Initial preparation used source/config metadata reads only. Subsequent isolated staging infrastructure creation is recorded below; no SQL connection, migration, invitation, payment or app deployment has occurred at that checkpoint.

## Evidence boundary

| Surface | Evidence available | Evidence still required |
|---|---|---|
| Expert acquisition → reviewed frozen data → text run/investigation/report | Approved combined 26-file source adopted and actual postimage hashes verified; SQL/Workflow/provider-transport tests and schema no-drift receipts retained in `naive-text-adoption-integration` | Isolated staging schema/configuration/grants, real provider/session/request receipts, genuine expert response/review, hosted timer/restart and delivery evidence |
| Candidate validation | 38 focused tests; original npm suite 3,579 passed, zero failures, two documented live-regeneration skips; full types and retained-dependency build | Exact deployment dependency/build receipt; candidate analytics substitution and transport/cost-fixture limitations remain recorded |
| Existing Naïve four-role setup | Historical Phase 0 provisioning/live diagnostics and earlier CI in `NAIVE_PLAN.md`, `LEDGER.md` and phase-0 receipts | Current read-only attestation of staging credentials, exact version pins, permissions and provider capacity; historical credentials/configuration are not current proof |
| Deployed application | LEDGER records older deployments and production lite configuration | Identify the actual deployed commit and isolated Preview target before claiming the adopted expert path is hosted; this checklist did not query remote deployment state |
| Other plan phases | Core components/provisioning plans exist | Generic five-method routing, remediation/rerun, workflow/comparison, company coordinator/deployments, sandbox migration/parity, approval/chat and full Phase 1–4 acceptance remain separate gates |

## Isolate staging before enabling work

- [ ] Record one clean source commit, its lockfile and exact dependency installation/build receipt. Do not deploy an uncommitted shared worktree.
- [ ] Provision a dedicated application database branch and a separate simulator seed child when branching/calendar tests are included. Record branch ownership privately. Do not point Preview at production or copy production customer data/credentials.
- [ ] Bind Preview `DATABASE_URL` and `DATABASE_URL_UNPOOLED` explicitly to that application branch. Use the direct connection for pinned transactions/session advisory locks. Presence of a URL alone does not establish its isolation.
- [ ] Provision staging-only auth/encryption, private artifact storage, target credentials, provider permissions and email sender/test-recipient configuration. Keep secret values in the owner's private configuration channel.
- [ ] Keep unrelated company/public-agent/monitoring cron dispatch and provider deployments paused/disabled for the test window; inventory actual source controls rather than assuming the proposed roadmap flags exist.
- [ ] Use `STRIPE_MODE=test`. Keep `AUTH_DEV_LINKS`, `DEV_SIMULATE_PAYMENTS` and `E2E_PIPELINE` out of production. Do not promote a local development auth bypass as hosted acceptance.
- [ ] Record the agreed test target owner, time window, inference envelope and any honorarium commitment before a real test. No cold outreach or unrelated target testing is part of this staging exercise.

## Migration order and schema prerequisites

Inventory the destination's actual migration history first. The historical ledger says some older sidecars were applied elsewhere; that is not a receipt for a new staging branch. Reconcile already-applied hashes explicitly. Do not replay replacement owner-artifact SQL after applying its current adopted migration.

| Order | Database | Exact source | Acceptance check |
|---|---|---|---|
| 1 | Staging application | Normal Drizzle journal sequence `packages/core/src/db/migrations/0000_init.sql` through `0022_uneven_nitro.sql`, only entries absent from the destination | Existing jobs/customers/experts/requests/engagements/responses/outreach/founder approvals/costs/private-report tables exist with expected constraints |
| 2 | Staging application | `0023_cost_receipts.sql` | `costs.receipt_key`, `receipt_identity`, unique partial provider-receipt index; inventory/reconcile legacy unkeyed Naïve receipts rather than deleting/backfilling them silently |
| 3 | Staging application | `0024_expert_automation.sql` | Policy, scope, qualification, operation, invitation and response-binding tables plus their constraints/immutability controls |
| 4 | Staging application | `0025_expert_workflow.sql`, then `0026_expert_text_runtime.sql` through the adopted Drizzle journal | `expert_workflow.plans`, `contribution_reviews`, `text_bindings`; matching 0025/0026 snapshots/journal; immutable authority/review/binding triggers; plan enabled/result fields retain intended mutability |
| 5 | Staging application | `packages/core/src/agents/persistence-migrations/001-agent-persistence.sql` | Durable task CAS, leases, reservations/settlements and budget-scope tables; replay/conflicting receipt checks |
| 6 | Staging application | `packages/core/src/evals/integration/migrations/001-text-integration.sql` | `text_integration.checkpoints` including ready/pending/completed/ambiguous states; no automatic lease expiry or ambiguous redispatch |
| 7 | Staging application | `packages/core/src/evals/data/persistence-migrations/001-evaluation-data.sql`, then `002-data-operations.sql` | Scoped task CAS and immutable completed data-operation records/result digests; operation immutability trigger |
| 8, branching gate | Staging application | `packages/core/src/simulator/ledger-migrations/001_branch_ownership.sql` | Branch ownership/cleanup ledger and direct-connection locking behavior |
| 9, calendar/workflow gate | Separate staging simulator seed child | `packages/core/src/simulator/migrations/001_calendar.sql` | Expected simulator tables/fixtures/reset/version isolation; never apply simulator schema to the application database by accident |

All application prerequisites above must exist before enabling a plan or invoking its runtime. Sidecar SQL is not in the application's Drizzle journal merely because the files exist; track its application/hash separately through the owner's migration procedure. Text-only execution does not create a simulator branch, so steps 8–9 are needed for branch/full-calendar conformance rather than its text-only run.

Do not apply optional autonomy SQL, a separate conversation store or workflow-investigation sidecars simply to satisfy this text checklist; inventory the consumers before extending scope. `npm run deploy` combines migration and production deployment, so it is not a staging schema-inspection command. No migration/deploy command is executed by this document.

Read-only verification can inventory `drizzle.__drizzle_migrations` (`id`, `hash`, `created_at`), `to_regclass(...)`, `pg_constraint`, `pg_indexes` and `pg_trigger` without selecting customer/credential contents. Retain destination-specific before/after migration and constraint receipts when the owner performs the migration. Verify transactional rollback and concurrent claims against that actual destination in addition to local PGlite tests.

## Configuration and current inventory

Required for the adopted text path:

| Configuration | Purpose / check |
|---|---|
| `EVAL_SERVICES` | Explicit `real` in the isolated Preview runtime; expert plans refuse otherwise |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Application data and direct pooled transactions; verify destination isolation privately |
| `CREDENTIALS_ENCRYPTION_KEY`, `SESSION_SECRET` | Staging credential encryption and authenticated sessions; the encryption key must match staged credential rows |
| `NAIVE_API_KEY` | Actual sessions plus Jude proxy; verify least necessary permissions, including `proxy:write` and `audit:read`, by current provider attestation |
| `NAIVE_AGENT_COMMERCIAL`, `NAIVE_AGENT_EVALUATION_ENGINEER`, `NAIVE_AGENT_QUALITY_INVESTIGATOR`, `NAIVE_AGENT_COMPANY_OPERATOR` | Explicit intended `<agentId>@<version>` pins with exact structured-output/tool configuration; the current factory requires all four |
| `NAIVE_JUDGE_MODEL`, `NAIVE_JUDGE_RESERVATION_MICRO_USD`, `NAIVE_JUDGE_MAX_OUTPUT_TOKENS` | Explicit model/pricing policy and positive integer limits; judge factory additionally bounds output tokens to 1–4096. No default judge policy is installed |
| `NAIVE_BUDGET_PERIOD_ID` | Stable agreed budget scope for the staging run; default monthly scope exists but should not be changed to evade exhausted reservations |
| `NAIVE_BASE_URL` | Optional; confirm approved provider origin privately before forwarding a key |
| `APP_URL`, `OPERATOR_EMAILS`, `COMPANY_ADDRESS` | Correct staging questionnaire links, authenticated independent operators, trusted sender identity; cold-contact postal-address requirement remains separate |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_COMMERCIAL_INBOX_ID` | Existing managed expert email transport; verify current sender, controlled recipient and delivery/reconciliation path. `AGENTMAIL_AUTH_INBOX_ID` serves auth; webhook configuration must match the actual staging receiver |
| `AGENTMAIL_WEBHOOK_SECRET`, `CRON_SECRET` | Current AgentMail inbound handler reads `AGENTMAIL_WEBHOOK_SECRET`; configure the actual staging receiver and retain signed inbound and unauthorized-request tests |
| Private storage configuration | `ARTIFACT_STORE` selects `neon` or `blob`; Neon requires `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_BUCKET`, `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY` (optional `NEON_STORAGE_REGION`), or Blob requires `BLOB_READ_WRITE_TOKEN`. Verify private storage and authorized downloads |
| `STRIPE_MODE` and staging Stripe credentials/webhook secret | Existing test-mode quote/payment/delivery lifecycle; no live card charge or honorarium payout in this checklist |
| `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_SIM_SEED_BRANCH_ID` | Additional branching conformance only; check dedicated staging seed ownership rather than using an arbitrary production seed |

Read-only local inventory (2026-11-08):

| Checked surface | Presence result |
|---|---|
| Immediate repository `.env*` files | `.env.example` only; templates do not supply credentials |
| Immediate `apps/web/.env*` files | None |
| Current process database/auth/encryption variables | `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CREDENTIALS_ENCRYPTION_KEY`, `SESSION_SECRET` absent |
| Current process Naïve runtime variables | `EVAL_SERVICES`, `NAIVE_API_KEY`, all four required `NAIVE_AGENT_*` pins, all three `NAIVE_JUDGE_*` settings and `NAIVE_BUDGET_PERIOD_ID` absent |
| Current process email/owner variables | `APP_URL`, `OPERATOR_EMAILS`, `COMPANY_ADDRESS`, `AGENTMAIL_API_KEY`, both inbox IDs, `AGENTMAIL_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `CRON_SECRET` absent |
| Current process storage/billing/branch variables | `ARTIFACT_STORE`, listed required Neon storage variables, `BLOB_READ_WRITE_TOKEN`, `STRIPE_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_SIM_SEED_BRANCH_ID` absent |
| Deployment files | `apps/web/vercel.json` present; root/app `.vercel/project.json` absent |
| Checked local CLI auth metadata | Vercel auth/config files absent under `~/.config/vercel`, `~/.local/share/com.vercel.cli`, and `~/Library/Application Support/com.vercel.cli`; `~/.config/neonctl/credentials.json` absent |
| Remote Preview/production variables and actual migration state | Unknown; no remote CLI/provider/database calls performed |

Local execution is blocked by missing configuration, not by proof of a bad remote credential. The root owner needs a **private staging-only credential handoff** for the application/direct DB connection, session/encryption secrets, Naïve key, target endpoint credential, selected private storage backend, AgentMail sender/inbound secret and test Stripe credentials; branch API credentials are additionally needed for branch conformance. Supply nonsecret role/version pins, approved Jude model/limits, Preview origin, operator identity and consent/policy records alongside them. Do not request replacement production keys merely because this checkout lacks local files. Expanded company-role MCP vault/task-token/callback credentials are later-phase inputs after those surfaces exist.

Presence does not prove validity, scope, deployment availability or sufficient balance. Do not paste secret values into this document, an issue, a tool log or chat; use the owner's private configuration channel. No credentials were copied or persisted by this inventory.

## Canonical authority and authenticated review setup

- [ ] Provision one staging customer and its real non-mock `text_eval` job through the existing authenticated/test-payment lifecycle. The expert runtime intentionally rejects `is_mock=true`; this is a controlled test environment job, not a mock success/revenue claim.
- [ ] Provision a disabled `expert_workflow.plans` row using trusted owner tooling: canonical job/tenant, immutable `ProductionDataInput`, `reviewDigest(input)`, trusted generic topic and fixed deadline. Bind `input.task.jobId` exactly; `input.context.systemPrompt` must match the stored endpoint prompt. Do not derive authority from endpoint/model output or manually forge `last_result='ready'`.
- [ ] Provision the selected enabled expert policy and matching `expert_automation_scopes`: canonical job/task/tenant/request hash/topic, policy reference and explicit customer-sharing consent. Current caps are $25 per evaluation and $50 company-wide per day; these are honorarium commitments, separate from the text job's $3 inference envelope. Do not increase caps to get a test green.
- [ ] Provision only genuinely opted-in qualified experts with retained qualification evidence, consent receipt, allowed uses and contribution source metadata. Recheck suppression/opt-out and exact allowed uses at every send/read. A new cold contact still goes through founder approval; customer details are not shared without current consent.
- [ ] Retain first promise day, deterministic expert operation identity, invitation intent, expert request/engagement/questionnaire and delivery receipt. Timeout/429/crash is never evidence that a send did not happen; reconcile the existing intent before any resend.
- [ ] Ensure an independent authenticated operator customer session exists. Existing `/api/operator/experts/...` routes manage expert/request/invitation operations, but do not themselves grant exact contribution or data-corpus approval.
- [ ] Provide a reviewed operator-only UI/handler for `reviewExpertWorkflowContribution(jobId,digest,review)` and `reviewExpertWorkflowData(jobId,digest,submission)` if one is not yet implemented. These are server-only helpers calling `getCurrentCustomer`; an unauthenticated CLI, public route or model-generated reviewer ID is not an equivalent authorization surface.
- [ ] Review the exact retained private questionnaire extraction snapshot; then review exact corpus/answer evidence, source permissions and independent principal. Preserve `data-review-request`, authenticated review, receipt and frozen operation bindings. Synthetic data remains synthetic; receiving a questionnaire does not establish factual truth.
- [ ] Enable the plan only after all prerequisites and limits are verified. Changing suite/target/credential identity after binding requires explicit owner reconciliation/new job, not deleting immutable bindings or reusing the old run ID.

## Bounded real operations and receipts to collect

These are future execution gates, not commands run during checklist preparation. Stop on unexpected permission/configuration mismatch, unknown billing, ambiguous effect, or an exhausted cap. Poll/resume deterministic identities; never create a new run merely to bypass a fence.

1. **Read-only provider attestation.** Inspect the current key's permitted capabilities, intended four role/version configurations and available model policy. Use a bounded read inventory; the provisioning CLI's `--inspect` and `--check` can make provider reads, whereas `--dry-run` is an offline plan. No provisioning, update, deployment resume or key rotation is implied by an inspection.
2. **Zero-budget refusal.** Before a paid session, prove budget zero refuses before provider construction/reservation/dispatch, with unchanged task/request counts and no new cost. Preserve the test receipt.
3. **One four-role diagnostic.** The existing `runLiveDiagnostic` supports an explicit new diagnostic ID/directory/budget period, $0.25/session and $1 aggregate envelope. Reuse its receipt IDs on replay and prove no extra session. Historical receipts do not substitute for staging SQL settlement. `scripts/naive-smoke.ts --budget-usd 1` instead covers qualify/report only; it does not cover expert acquisition or the rich text runtime.
4. **One controlled expert job.** Use one permitted HTTPS test endpoint and one opted-in expert, one canonical task/plan and one invitation identity. Record the authorized honorarium amount before the promise (at most $25, also subject to the $50 day cap); no payout is automated. Keep total job inference within the existing $3 cap. Jude reservation is local admission, not a provider monetary ceiling; explicitly bound the model/input/output and reconcile actual billed usage. The frozen suite has 12 scenarios; retain the actual target-call count and bounded reproductions rather than advertising an invented operation maximum.
5. **Real questionnaire and review.** Wait for the genuine controlled expert response. Retain actual send/delivery/response identities and authenticated independent review receipts; do not preseed an approval to bypass the wait. Verify the existing Workflow continues through freeze, actual execution, investigation and report without manual restart.
6. **Evidence and cost settlement.** Retain agent session IDs, Jude request IDs/audit usage, measured amounts and idempotency keys; reconcile against `costs` and provider audit. Verify lost acknowledgement replay charges once, full rich artifacts are retained before projection, exact citations remain valid, and report counts/limitations match retained evidence. Rubric concerns are not confirmed findings. Remediation/rerun remain explicitly absent.
7. **Hosted restart/revocation/hold.** Recreate the server/Workflow process using retained state, then prove no repeated completed target/session/send. Check cancel, opt-out, plan disable, owner change, credential deletion/rotation and deadline expiry. Entirely unassessed/infrastructure-only outcomes must hold with no normal report delivery/settlement. An ambiguous operation must remain fenced. Preserve the separate controlled test-job records; do not corrupt the successful job's immutable evidence to manufacture a fault test.
8. **Existing report/payment path.** Verify private downloads and tenant access, report coverage/limitations, Stripe test settlement idempotency and notification exactly once. Require a genuine assessed outcome before a delivered result. Confirm no lite method substituted on the explicit expert route.
9. **Broader conformance.** The existing `scripts/conformance.ts --services real` exercises the generic service factory, whose five-method routing is still incomplete. Record its actual failures/skips; do not count the explicit expert route as generic conformance success. After general routing is implemented, run skip-branching/full/controlled-target variants and require zero unexplained failures before Phase 1 promotion.

## Open blockers and later-phase gates

- [ ] Independent app-level proxy reconciliation after crash plus revocation: core Jude can recover a retained request, but a revoked plan can prevent runtime construction/replay. Preserve the request/reservation for reconciliation; do not redispatch. This remains an implementation gate, not a missing environment variable.
- [ ] Authenticated contribution/corpus review surfaces and trusted plan/grant provisioning must be concrete and access-tested; helper exports alone do not provide an operator workflow.
- [ ] Generic design/run/investigation/remediation/rerun method routing, resolved-finding lifecycle contract, real fix/retest and workflow/comparison mappings remain outside the adopted expert text baseline.
- [ ] Phase 2 requires the internal MCP/task-token authorization, vault credentials, callback verification, company runtime/cron ownership, paused deployments/coordinator/board and approval bridge before any expanded-role activation. The plan's proposed flags are not evidence those consumers exist. Require the plan's seven-day dry run, ≥98% schema validity, exact URL provenance, zero unapproved sends and caught numeric mismatches.
- [ ] Phase 3 requires actual scenario/simulator/judge/media provider routing and τ² oracle/null/mutation parity, pass^k/CI comparison, cost/trial ≤1.5× and p50 latency ≤2× the documented baseline.
- [ ] Phase 4 requires every `ask`/`ask_operator` park to resolve through authenticated confirm/deny/expiry with an audit row, plus exact numeric narrative checking. Optional computers remain a separate security-review gate.

Rollback is scoped to the active path: disable expert plans/scopes/policies to stop new expert/target publication and preserve journals/reservations. Setting `EVAL_SERVICES=lite` makes explicit expert plans hold; it does not authorize a silent lite fallback for those plans. Generic routes may use their existing lite behavior. Deployment changes and provider pause/resume are separate owner operations; reconcile already-started requests and commitments before deleting anything.

## Subsequent root verification

The previously supplied private Naïve key file remains available even though no key is present in the current process/app env files. Root used the verified provisioning CLI for a bounded read-only inventory, with no resource/session creation. Four configured role entries were returned; configuration attestation and expanded provisioning remain open. Nonsecret receipt: `naive-phase0-inventory-20261108.json`. The private Neon credential was supplied. Read-only API metadata confirms project `icy-star-64097833` (`autonomous-evals-pg18`, PG18, aws-us-east-2) and its recorded main/sim-seed branches. No SQL connection, branch creation or migration had occurred at this inventory checkpoint.

Actual adopted source `9eb9e4c` passed full [GitHub CI](https://github.com/azoghby/standard-evals/actions/runs/42466546567), including locked install, types, tests and default production build. This supersedes the local retained-dependency build limitation for that source commit, not the hosted activation gates.

## Isolated infrastructure checkpoint (2026-11-08)

Root created schema-only branch `naive-staging-20261108` (`br-polished-star-bdxodsin`) in the recorded project; all eight branch operations finished. Its read-write endpoint is capped at 0.25 CU, suspends after 300 seconds and the branch expires 2026-11-15T09:34:02Z. Fresh role `naive_staging_owner` and fresh database `naive_staging` creation requests were accepted; their response credentials are retained privately outside the repository. No production rows were copied by the schema-only request. Nonsecret receipt: `naive-staging-infrastructure-receipt.json`.

Next: confirm database operations finished, retrieve its private connection URI, verify exact branch endpoint/database identity, then apply the committed migration sequence to this fresh database. The inherited schema-only database is not the migration destination. SQL connectivity, migrations, hosted authorization and real provider acceptance are still unverified.

### Later staging SQL verification

The dedicated role/database creation operations finished. Root verified the API-selected endpoint and SQL database/current role, observed zero initial application tables, and applied exact committed `11d7ff2` SQL: all27 Drizzle migrations and four agent/text/data sidecars. Replaying Drizzle left all27 journal hashes unchanged. Real PostgreSQL checks passed: completed data-operation mutation refused, rollback removed the operation fixture, two concurrent connections retained exactly one idempotent task, and expected authority/review/operation triggers exist. The temporary task fixture was removed. See the expanded nonsecret infrastructure receipt for every migration SHA and check.

This supersedes the earlier “no SQL connection/migration” checkpoint only for this isolated branch. No production schema, hosted app deployment, genuine human review, provider session, outreach or payment is implied. Core source11d7ff2 also passed complete GitHub CI42467560403. Root checkout typecheck/npm tests were attempted again but cannot start because local TypeScript/Vitest executables are absent.
