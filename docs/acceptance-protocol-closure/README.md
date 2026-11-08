# Acceptance protocol closure — offline owner artifact

No live acceptance is established or authorized. This additions-only artifact fixes concrete identity/receipt representation and accounting seams without editing application, core, historical artifacts, configuration or credentials. The local commit stays on the assigned task branch; LEDGER updates are recorded here because ownership explicitly excludes root LEDGER.md and track-a.

`identity/protocol.mjs` derives applied prompt hashes from the actual observed core dispatch payload and checks unchanged endpoint/model/targetVersion against independently configured approval. Raw UTF-8 prompt SHA256 and structural remediation digests remain different identities. The durable pre-dispatch authority must atomically fence operations across processes; an ambiguous operation remains reserved. Offline review strings are synthetic and cannot approve a real proposal. Host fixture metadata is never remote attestation.

`identity/0001-v2-identity-compatibility.patch` extends app_acceptance/v2 while retaining existing report, SQL, accounting, process restart and private chat assertions. It targets the exact file preimage at 7f492e2cba2004eca4aeff13752a9380f602f2dc. Use `node docs/acceptance-protocol-closure/stage.mjs` to verify/apply in a new disposable directory. Review PATCH.json hashes first. Install the identity module at the same repository path as this artifact before applying the validator patch. Different owner source requires explicit rebasing; do not overwrite historical artifacts.

Calendar uses full12 actual SQL results. Independent jobs preserve each job-bound suite digest via `versionBinding`; the canonical scenario digest binds inventory and does not replace either application suite digest. Each SQL row keeps actual job/run/branch/suite identity. A two-scenario smoke cannot pass the full12 extension and cannot be relabelled full acceptance. Existing same-job v2 evidence remains backward compatible.

The immutable approved limits remain target32, Gateway16, Naive0, cloudMutation0, 180 seconds. The full success path is target77, Gateway50, Naive10 minimum. Additional polling, retries, failures or missing retained reviewed suite require more capacity. `metering/protocol.mjs` refuses this plan before reading private runtime, and refuses caller cap inflation. Unknown usage/price remains null with held reservations; completion ceilings are never measured billing. Read metering/README.md for the reservation formula and exact missing monetary bounds. The local fsync meter is offline protocol evidence, not hosted transactional durability.

Reproduce with existing dependencies (no install):

```sh
node --test tests/track-b/acceptance-protocol-closure/identity*.test.mjs tests/track-b/acceptance-protocol-closure/meter.test.mjs
node docs/acceptance-protocol-closure/stage.mjs
node tests/track-b/acceptance-protocol-closure/run.mjs
```

The applied-source runner uses the exact historical metered composition and its original core/app factories, SQL persistence, actual separate-process restart and fake provider ports. It adds an exact admitted Lumen12 baseline/trial test: all objectives/rubrics retained, 24 target requests and 48 fake Gateway observations, inconclusive rubric verdicts retained. It does not substitute fixture passes for hosted rubric acceptance. Existing actual core remediation route tests cover payload-derived receipts and all12 objective results. Existing Calendar factory tests retain all12 per version and two buggy SQL reproductions (52 requests), and restart dispatches zero times. Strict app-kernel/test typechecking occurs in disposable staging, without source rewrites in the owner checkout.

Current app team coordination is separate. CURRENT-CANDIDATE.json captures the reviewed candidate at parent0398517, candidate commit f88811c8fb7509dc5996bb8cd1d148e4c23f3de3, with its exact source hashes and receipt verifier interfaces. No files in that team's worktree were edited. Its Calendar autonomous dispatch is explicitly blocked on trusted durable targetForScenario run identity, chat UI is unmounted, and releaseAccepted=false. Historical metered-stage results here do not certify that current candidate or close its startup/payment/transport/source/outbox adapters. Parent must compose this protocol after reviewing the current candidate and repeat applied-source verification on the exact final bytes.

Remaining gates, all owner-controlled:

1. Approve a new complete operation/time/token and monetary plan or an explicitly different scope; unchanged 32/16/0 cannot run full acceptance. No 180-second provider latency fit is established.
2. Obtain authentic Naive proposal/task/session records, independently review exact replacement bytes, and freeze the approved raw prompt hash server-side. Candidate output cannot self-approve.
3. Owner-apply/build the exact current composition and validator adapter; bind canonical tenant/job/finding/baseline/version/trial identities and trusted Calendar durable run/branch scopes; reconcile migration order before any hosted SQL use.
4. Deploy only through separately authorized owner action: public HTTPS/DNS/TLS target, independent fixture authority, no request/header/prompt logs, exact deployed patch/source provenance. Fixture origin remains internal_fixture, never external inference.
5. Execute real reserved Gateway judgments and real provider ports with current credentials and cancellation; transactional hosted dispatch fencing, PostgreSQL multi-session concurrency and process restart require independent evidence.
6. Authenticate observed provider receipt evidence at trusted verifier boundaries. Current paid receipt shape is `{operationId,inputDigest,receiptId,microUsd:number|null,evidence}`; verifyPaidReceipt gates reconciliation, verifyPayment gates settled USD quote coverage, verifyProviderReceipt gates recovery without redispatch. Unknown price retains reservations/outbox; authenticated usage alone is not money.
7. Verify private report persistence and owner/tenant/current revocation handling and mount/review private chat UI in the final candidate. No hosted, billing, customer-model correctness or provider approval is inferred from these offline tests.

Verification results: 20 applied-source tests pass with strict app-kernel/test compilation, plus 16 protocol/actual-core/v2 compatibility tests and nine original controlled-remediation route tests. No pending/skip is accepted by this artifact's runner. The requested checkout commands were attempted: `npx --no-install tsc -p apps/web --noEmit` found an unusable compiler shim; `npm test` failed because Vitest is absent from this worktree. Their logs are retained. No dependency installation was attempted; applied-source verification uses the existing `/tmp/workflow-bootstrap.JpxCTM` dependency cache and route tests use `/tmp/track-b-harness`. A full final current-candidate Next/Workflow build remains the owner's composition check; no such build is claimed here.

Log: 2026-11-07 — added exact-base v2 patch and actual receipt bridge; added durable attempt/observation meter with late authenticated null-to-measured reconciliation; verified full12 independent Calendar SQL identities and replay; retained exact frozen Text12 baseline/trial and fake-provider inconclusive judgments. Root/app/core/historical files unchanged. Remaining gates are listed above.

Final local commit is blocked by the worktree Git HEAD becoming dataless: repo discovery blocks reading it. No metadata repair or cloud hydration was attempted. See verification/BLOCKER.md; completed test results remain valid, and interrupted final repetitions are distinguished in verification/STATUS.json.
