# Pinned service composition verification

This is local boundary acceptance plus explicit defect/scope characterization. It is **not full release acceptance**. ECC disabled. Track A is read through local Git only at `8634ceb30f3d98de7ec24b240a4f7549dce80033`; Track B parent is `6ff8a0642fc14dfd23842456d124a4b84f5e040a`. No fetch, installs, provider/cloud calls, credentials, deployments or application modifications are used.

## Combined strict scoped entrypoint

From the repository root (or any directory inside the repository, with the script path adjusted):

```sh
TRACK_B_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules \
  node tests/track-b/release-contracts/services/run.mjs
```

The runner resolves the repository via `git rev-parse --show-toplevel` from **cwd**. Invoke as a child process from a combined test lead runner; exit 0 means strict scoped TypeScript and all 14 boundary/characterization checks passed, never that release gates closed. Exit nonzero means missing/moved pin, dependencies, compilation error or incomplete/failing execution. No tests are skipped or substituted. No shared runner/package/manifest edits are necessary.

`TRACK_B_NODE_MODULES` must name existing local dependencies. Without it, the runner tries `tests/track-b/node_modules`, then the known existing offline directory above. That directory is machine-local and may disappear; missing dependencies fail with no installation attempt. The recorded run used TypeScript from that existing directory and Vitest 5.1.0, Node v24.21.0. One worker, one test file, 14 checks. TypeScript checks the staged production dependency closure with `strict: true`; no app build or broad fixture suite runs.

The runner stages byte-for-byte pinned Track A contracts, `integration/compose.ts`, lite code, red-team code and **the full actual app `server/services.ts`**. Track B source comes from cwd. It verifies exact method inventory, error reasons, all ten TRACKS B requirements and blob provenance. It rejects a moved local `origin/track-a`. Temporary staging is deleted even on failure.

## Results and machine-readable gate map

[Recorded executable output](../../../tests/track-b/release-contracts/services/results.txt): **strict scoped TypeScript passed; 14 tests executed, none skipped**. Five acceptance cases S01–S05 cover local routing/rejection contracts; nine cases S06–S14 characterize observed behavior/map coverage. A green characterization preserves the known observation and must not be counted as requirement acceptance.

[Service gate map](../../../tests/track-b/release-contracts/services/service-map.json) has schema `track-b-service-gates.v1`. It covers all 12 actual EvalServices method keys, their raw real status, app-real routing, lite semantics, evidence IDs and explicit gates. Five raw-real methods are unavailable: designSuite, runSuite, investigate, proposeAndVerifyFix and rerunFinding. All release statuses are `gated`; `releaseAccepted` is false. Ten `requirements` rows map TRACKS B1–B10 to unclosed acceptance work; `deploymentGates` records unexecuted app/payment/recovery/customer gates. Evidence scope is explicitly boundary-only.

## Exact composition versus lite

At this pin, `apps/web/src/server/services.ts:getEvalServices` selects mock by default. `EVAL_SERVICES=real` selects `withWorkflowErrors(withLiteFallback(trackBServices, liteServices()))`. **“Real” is therefore a hybrid**. The app catches only `EvalServiceUnavailableError`, then invokes the lite method. Pending, blocked, configuration and ordinary errors propagate; typed errors map to Workflow retry/fatal classes. S01 tests actual unavailable closures and exact reasons without initializing agent/branch dependencies. S05 executes the actual app wrapper, and S06 executes actual `getEvalServices()` real selection.

| Surface | Observed executable behavior | Full Track B requirement still gated |
| --- | --- | --- |
| Agent-backed qualify/auditTrace/renderReport | Lazy composition delegates to B adapter; failed host configuration retries without using lite (S02) | Four real Naïve configurations, SQL persistence, budgets, actual provider outputs, full measured cost ledger and secret-policy binding |
| Target/branch helpers | HTTP localhost refused before any I/O (S04); injected branch ports are forwarded and initialized once (S03) | Complete HTTP security and real owned Neon lifecycle |
| Design | Real selection falls back to lite at zero budget: six template scenarios plus appended red-team cases (S06) | Reviewed digest-addressed frozen twelve, durable design/review, factual admission |
| Ordinary objective checks | Fixture judge says pass for `WRONG`; lite returns pass, but real B `evaluateObjectiveCheck` fails the same contains spec (S09) | Objective code grading in the app execution path |
| Infrastructure | Transport exception becomes boolean `passed:false` with `grader:error`; actual lite investigator omits it (S08) | Rich infrastructure/inconclusive state and app/UI preservation; not a confirmed customer defect |
| Replay | New lite factory redispatches target and repeats counter-based run ID (S10) | Durable checkpoints, lost-ack reconciliation and version/run isolation |
| Tools/branches | Lite returns `lite://no-database`; tool call receives unavailable stub; request has no function tool definitions (S07/S11) | Real calendar tool execution, SQL state graders, six-round cap, isolation and buggy/fixed SQL evidence |
| Factual rubric | No reference supplied; injected judge pass still yields pass (S12) | Missing reference must remain factual correctness not assessed |

B has richer factories under `evals/integration/services.ts`, `evals/calendar-integration`, remediation, comparison and monitoring sources. Their existence does not bind them into this pinned app. The raw `proposeAndVerifyFix` reason saying no engine exists is stale; S01 deliberately checks the exact emitted reason, not its truth. This suite does not claim full rich factory acceptance merely from exports.

## Minimal reproductions for owners (no fixes outside ownership)

Run the entrypoint, or filter `services.test.ts` by S ID after staging within an integration runner. The single entrypoint avoids relying on temporary paths.

- **Track A app/composition + B integration owners:** S01/S06 show unavailable real methods served through lite; supply authorized durable suite/run/target/branch context and bind richer factories, preserving their states rather than narrowing to booleans.
- **Track A lite execution owner:** S09 constructs one objective contains-REQUIRED check, returns `WRONG` from the injected transport and `{passed:true}` from the fixture judge. Actual lite reports pass; B objective evaluator returns fail. Execute ordinary objective specs with code.
- **Track A lite/recovery owner:** S10 runs the same suite once in each of two new real lite factories; each target spy receives one call and both run IDs are equal. Bind stable persisted operation identity/checkpoints; rebuilding the factory is a local restart characterization, not proof of a deployed crash.
- **Track A lite/data integration owners:** S12 supplies a factual rubric and no reference with a fixture judge pass; actual lite returns pass. Preserve not_assessed before judging unsupported factual correctness.
- **Track A lite/calendar integration owners:** S07/S11 show placeholder database and unavailable tool stub. Gate calendar claims until real simulator SQL/branch execution is wired. A placeholder cannot demonstrate branch isolation or cleanup.

These are outside this child's ownership. No app, platform, contracts, manifest, production code, shared test runner or other team's paths were changed.

## Explicit boundaries and limitations

Host/bootstrap/provider modules are deliberately replaced by files in the owned `boundaries/` directory: app database bootstrap, target credential resolver/validator, mock-only helpers, Workflow error classes and server-only marker. The AI Gateway boundary has typed fixture interfaces and throws on default generation; **production Gateway code and its credential guard are not assessed**. Fixture generation validates against actual schemas supplied by lite code. Tests replace target transport with explicit local responses. DNS/HTTPS/fetch tripwires throw on accidental calls. No fixture is provider/customer evidence.

The actual app services wrapper, core composition, lite logic, shared contracts, red-team selection, target protocol parsing, target URL validation and B objective evaluator run unchanged. Production bootstrap is not imported: Neon/Drizzle/AI SDK/Workflow host dependencies are absent from the known offline dependency cache. Strict TypeScript therefore verifies this explicit boundary closure, not the missing production host implementations. S03 checks forwarding with branch port doubles, not Neon or SQL. This child intentionally adds no SQL fixture suite; the release-contract SQL child owns those checks.

No complete Trace/Commercial/Operator live acceptance, app auth, Stripe, Blob, Vercel Workflow execution, true serverless process recovery, real DNS/HTTPS target call, Naïve SDK execution, Gateway judgment, cloud branch lifecycle, simulator SQL state, full comparison/monitoring, remediation application, cleanup or production migration is accepted here. Those are explicit gates in the machine map, not silent skips. The services tests do not modify or claim ownership of the other teams' integration or pack tests.
