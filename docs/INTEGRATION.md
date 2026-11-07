# Track B -> Track A integration handoff

Goal: drop Track B's real `EvalServices` into the app safely, gated by an automated conformance run.

## Steps

1. **Implement `EvalServices`** (`packages/core/src/contracts/services.ts`) under Track B's owned dirs
   (`packages/core/src/agents|evals|targets|simulator|reporting`). Every method returns data that parses with the Zod
   contracts in `packages/core/src/contracts/index.ts`.
2. **Export `evalServices`** from `packages/core/src/evals/index.ts`:
   ```ts
   import type { EvalServices } from "../contracts/services";
   export const evalServices: EvalServices = { /* ... */ };
   ```
   The app loads exactly this export (`getEvalServices()` in `apps/web/src/server/services.ts`).
3. **Run conformance** from the repo root:
   ```
   npx tsx scripts/conformance.ts                    # full
   npx tsx scripts/conformance.ts --skip-branching   # no Neon access
   npx tsx scripts/conformance.ts --skip-suite       # trace-audit-only milestone
   ```
   It prints a PASS/FAIL/SKIP table and exits 0 only if no check fails (exit 2 = module missing or no export).
   The same harness runs against the mock in `packages/core/src/contracts/conformance.test.ts` (`npx vitest run`).
   `runSuite` is only exercised when you call `runConformance(services, { runSuiteTarget })` programmatically, since it hits a live target.
4. **Fix every FAIL**, then rerun until clean. Skips must be intentional (flags above).
5. **Switch the app**: set `EVAL_SERVICES=real` in the Vercel env (Production + Preview as needed) and redeploy
   (`npm run deploy`). Leave it unset or `mock` to keep serving labeled mock results.
   Note: with `real`, `getEvalServices()` throws if `@ae/core/evals/index` has no `evalServices`.

## What conformance checks

| Method | Checks |
|---|---|
| qualify | output parses as `QualifyResult` (trace_audit, text_eval); no price fields or dollar amounts (agents pick a package, never a price) |
| auditTrace | unsupported-success-claim fixture gives >=1 `confirmed`/`rubric_concern` finding; clean fixture gives 0 `confirmed`; every finding parses, has valid enums and >=1 non-empty evidence excerpt |
| checkTarget | rejects `http://example.com`, `http://127.0.0.1`, `https://10.0.0.1`, `https://169.254.169.254`, `https://localhost` (`ok:false` or throw) with zero `fetch` calls (global fetch is spied; do the URL/IP check before any DNS or network) |
| renderReport | schema-valid `Report`, non-empty markdown and html, no `<script>`, `jobId === ctx.jobId` |
| proposeAndVerifyFix | schema-valid `Remediation`, `findingId` matches |
| designSuite / investigate / rerunFinding | `Suite` valid (`jobId === ctx.jobId`, unique scenario ids); findings valid; rerun keeps id and evidence |
| recordCost (all methods) | every entry has a non-negative integer `microUsd` |
| budget | `ctx.budgetMicroUsd = 0`: throw an error whose name/message contains "budget", or complete with zero recorded cost |
| branching | `createJobBranch` -> `getJobBranchConnection` (required if create exists) -> `deleteJobBranch` |

Fixtures: `packages/core/src/contracts/fixtures/index.ts` (unsupported-claim trace = `e2e/fixtures/trace-unsupported-claim.json`, plus a clean trace).

## Rules for implementations

- **Model calls**: go through `packages/core/src/ai/gateway.ts` (AI Gateway wrapper, being built by another worker; read its exports there). Do not instantiate provider SDKs directly, so spend is attributable and capped.
- **Costs**: after every paid call, `await ctx.recordCost({ source, agent, sessionId, microUsd, meta })`. `microUsd` is a non-negative integer. Never record floats or negatives.
- **Budget**: check `ctx.budgetMicroUsd` before paid calls and throw a typed error (name/message containing "budget", e.g. `class BudgetExceededError extends Error`) when it cannot cover the work. Track A pauses the job on that.
- **Progress**: use `ctx.recordProgress(milestone, message)`. Customer-visible text only; no secrets.
- **Never write app tables directly** (jobs, costs, findings, ...). Return validated data; the workflow persists it. Simulator state lives only on per-job Neon branches.
- **Secrets**: `apiKey` and branch connection strings never appear in returned data, findings, evidence, reports, or logs.
- **Target security**: HTTPS only, reject private/loopback/link-local before any network call, resolve DNS and re-check, no redirects, timeout, bounded response.
- **Dependencies**: ask Track A to install them (single lockfile).
