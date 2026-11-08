# Text cross-service release evidence

Base: `6ff8a06` (parent main). ECC disabled. Only this directory changed.

Command (offline, existing dependencies only):

```sh
node tests/track-b/cross-service-release/text/run.mjs
```

Result: strict TypeScript compilation passed; **2 node:test acceptance cases passed**, zero failures/skips/todos. Exact captured output is in `results.txt`. The runner stages current production source and uses locally available Track A contracts at `be522f1e13e697017bac96728748b82cadc08ab9`, following the existing review-runner convention because this checkout has no `packages/core/src/contracts`. Override `TRACK_B_REVIEW_NODE_MODULES` / `TRACK_B_CONTRACT_REF` for a different local dependency cache / integrated contracts revision. It performs no installs or fetches.

## Acceptance evidence

`cases.ts` exports `textPendingRestartConsistency()` and `textPendingTargetRestart()` for a lead's combined scoped check; `text.test.ts` supplies standalone node:test wrappers.

- Actual `createTextEvaluationServices`, `AgentSessionService`, PostgreSQL task/budget/checkpoint adapters, renderer, durable progress reader/projection, private chat service, and PostgreSQL conversation adapter execute against file-backed PGlite with production migrations. Services/adapters are recreated and the database is closed/reopened. The existing local Naive fake supplies only external session responses; the target supplies a deterministic local response. No providers or network are used.
- Design produces an admitted frozen suite. One selected scenario fails its objective check. Investigation first returns pending, with an inconclusive provisional candidate; `reportInput` throws `TrackBPendingError`. SQL progress has no committed findings and an explicitly pending investigation. Private chat reports zero *recorded* findings with the absence-of-problems caveat.
- After SQL reopen, investigation resumes the same stored agent session, reproduces the failure exactly once, and confirms one finding. Original run and finding payloads agree with report input; rendered report and private progress each count one confirmed, zero inconclusive findings. Three measured cost checkpoints agree with report/progress totals; provider costs remain unknown.
- Private chat omits response/check bodies. SQL reopen preserves history and immutable early replies, while fresh findings replies show the later confirmed count. Unchanged poll cursors survive restart. Replaying run/investigation sends nothing further: two target calls total, three agent sessions total (design, review, investigation).
- A claimed target checkpoint simulates a worker lost before acknowledgement. Two database reopen/retry cycles return pending without any target dispatch. Planned run result stays missing, status remains running, and no findings/report conclusion is fabricated.
- A negative control changes the persisted finding's reproduction run ID to `foreign-run`; projection rejects it as `invalid_snapshot`.

## Characterization and limits

No production defect was exposed by these cases; there is no demonstrated failing acceptance repro to hand off. The pending provisional candidate versus zero committed findings is characterized explicitly, not treated as a defect or a final clean result. The negative corruption control proves rejection of that specific association mismatch, not universal tamper resistance.

Minimal reproduction: run either exported async case, or the command above. The pending-target setup computes the production target checkpoint key and claims it without completing it, then invokes `runSuite` after reopen; no original test is edited.

This is local engine/SQL evidence, not deployed application or cloud PostgreSQL certification. PGlite is single-connection; the consistent read port pins one transaction and rechecks inventory there, but this does not prove concurrent PostgreSQL isolation or application authorization wiring. The fixture application job fact and inventory resolver are local SQL support, not a shipped app adapter. The application cost sink is intentionally inert; accounting comparisons use durable production cost checkpoints and do not certify delivery to an external sink. Fake external sessions remain in local memory across worker/database recreation, representing an available remote session; this is not a separate-process provider restart test. Only one objective scenario and one reproduction are executed, not broad fixture suites. No deployment, push, PR, credentials, paid calls, or outreach.
