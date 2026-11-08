# Sandbox engine independent security review

Review baseline: main `e4686a84f248bfe8be9bcda4ed534b0807379714`. Contract/plan pin: `aa94505fd535f5c0f586cc6325b49b71a1683761`; spec SHA-256 `71ae878f2fd00fb71a82a1310afeee1c490c7cade6cddb903e19bb2dbb147ffe`. Read current Track B identity, generation, execution, grading and integration handoffs. Two native children reviewed generation and execution; parent reviewed identity, grading, integration and current Track A compatibility. ECC disabled. Production was read-only; no provider/cloud calls, credentials, spend, migrations, deployment, sends or push.

## Findings requiring parent decisions

These are reproducible characterizations, not demonstrated external credential theft or approval bypass. Passing characterization tests document current gaps; they are **not acceptance of the vulnerable behavior**. Parent owns fixes and regression conversion.

| Boundary | Reproduction and reachability | Minimal suggested parent fix |
| --- | --- | --- |
| Generation secret rotation | `generation/adapter.ts:111` copies `knownSecrets` at construction. Adding a synthetic rotated marker to the original list does not screen that marker from a later generation request; reconstructing the adapter blocks it. Requires trusted configuration rotation without adapter replacement. | Tie adapter lifetime to secret-set epoch, or obtain a trusted fresh list before each dispatch and screen output with the accumulated set. Preserve task identity and budget fencing. |
| Target response rotation | `execution/target.ts:117` dispatches after preflight screening; output screening uses the snapshots acquired before transport. A synthetic marker registered during transport is returned. Pre-dispatch rotation during reservation **is** caught. This supplies a synthetic response through an injected transport; it does not establish how a remote agent could learn credentials. | Bounded post-response secret refresh, screen against the union of prior and current sets, keep unknown accounting holds on failure. |
| Simulator mutable input | `execution/simulator.ts:87` renders caller-owned knowledge after awaiting driver selection. A direct API caller can replace upfront fact 0 with the never fact while waiting; driver projection never saw that fact but final text contains it. The normal runner supplies detached persona data; no route-level customer ability to mutate it was established. | Snapshot persona/conversation/disclosure input at entry and render from the detached authorized facts used for selection. |

No speculative severe rating is assigned. Secret sentinels are invented test data. Delimiter escaping is structurally verified; it cannot establish LLM resistance to prompt injection.

## Acceptance evidence versus trusted ports

New tests exercise real modules and actual local PostgreSQL through PGlite, including actual oracle/null/mutation orchestration, deterministic grading and SQL checkpoint stores. They reject missing/stale server approval despite caller-added approval fields, snapshot caller artifacts before approval awaits, clear generated `oracleValidated`, reject altered persisted rules and isolate immutable input snapshots.

Actual AgentSessionService budget exhaustion prevents session creation. Target authorization or dispatch-fence rejection prevents transport. A pending SQL gate intent prevents oracle provisioning after restart; a fresh target adapter sharing an ambiguous fence cannot redispatch. The latter uses a server accounting fixture, not a hosted durability claim. Generation cap forwarding alone is labeled separately from actual reservation.

An injection asking for hidden indices cannot disclose never/unauthorized when-asked facts through the constrained simulator. Actual SQL unauthorized audit state fails security despite clean assistant prose and no canary leak. Absent attack exposure leaves the security-evidence check unknown; independently confirmed collateral damage still fails aggregate security. This checks deterministic boundaries; it does not measure live model attack success or solve exposure eligibility for null controls.

Integrated SQL snapshot checks reject an honestly identified foreign world and release the snapshot. Deliberately replacing the **trusted** `finalSnapshot` authority with an alien SQL reader, relabeled run ID and copied execution diff/trajectory can influence grading. This is privileged-port trust, not a caller-selected cross-world exploit. Overall outcome stays unknown because cost is unsettled. Minimal platform requirement: immutable snapshot receipt binding world/run/execution, authorized private lookup and atomic capture before teardown. Do not claim that string IDs or matching summaries authenticate SQL provenance.

Likewise, a dishonest injected candidate assessor can manufacture a proposal but cannot itself supply customer approval. Hashes bind content, not truthful execution. Approval resolution, complete-diff attestations, security exposure, predicate selection, authorization, budget accounting and report storage must remain server-owned. This review does not race or replace the stateful grader work.

## Compatibility with current Track A

Read exact Track A `875ceef6a743df41736ee55c4145ca794e0854a8`, runtime addition `36b1f7227ec15a3188973a09f9b1e0e5de16e6eb` and media addition `fc45714ce501aae3e9178aafe219d120be10bd0a`. The runtime and media implementations **exist**; earlier platform absence is not a finding here.

The owned harness stages unchanged A runtime SQL modules from Git and runs `createSandboxRun` against local PostgreSQL, alongside B compiled against the unchanged aa94505 shared contract. No Neon branch manager or live runtime is invoked. Real A query accepts SELECT/WITH, rejects direct and CTE writes, uses READ ONLY transactions with a 5-second statement timeout, and returns at most 5,000 rows. B boolean SQL predicates fit this protocol. Timeout configuration is source-reviewed; no wall-clock timeout/Neon acceptance is asserted.

An eight-row update yields eight actual `sandbox_diff` rows but five `StateDiff.sample` entries. B correctly retains same-table write collateral as unknown under v1's table/description-only allowedChanges. Full row evidence now exists through A's SQL relation; parent must bind approved row predicates and completeness to that relation rather than treat sample absence as authorization. Use SQL aggregates or bounded/keyset protocols; `query`'s row cap cannot establish complete coverage of a raw row enumeration above 5,000. SQL permission enforcement, reserved runtime tables and snapshot lifecycle still require adapter integration review.

A's newer spec adds optional `ToolCallRecord.executed` and optional query params. B preserves tool records and counts attempted calls for process bounds, so optional metadata alone creates no runner incompatibility. At exact 875ceef, runtime `run.ts` does **not** actually populate `executed` on its pre-execution fault paths; errors/fault values are present. Parent must not infer successful execution from missing metadata, or drop short-circuited attempts from bounds. Re-check implementation at the selected adoption revision.

A media oracle extracts field keys without giving expected values to the image reader and checks injection canary visibility; its voice driver supports chat audio with nonstreaming timing and typed realtime seams. B's current tool-loop runner still rejects media/nontext. Mapping A media to B's secured media ports, exact asset/model/config identity, durable pre-dispatch budget admission, independent ground truth and exposure evidence remains acceptance work. Existence of A adapters does not by itself make composed voice/vision or billing accepted. No media provider was called in this review.

## Reproduction and remaining gates

```sh
TRACK_B_NODE_MODULES=/tmp/sandbox-generation-deps.cBCEai/node_modules \
TRACK_B_RUNTIME_NODE_MODULES=/tmp/workflow-bootstrap.JpxCTM/node_modules \
node tests/track-b/sandbox-security-review/run.mjs
```

Harness merges symlinks to existing dependencies in temporary staging, preserving primary versions; it installs nothing and changes no dependency tree or manifest in the checkout. Runtime simulate imports require AI SDK packages from the second tree, but no gateway function is invoked. Whole-tree secondary dependencies alone exposed an existing ipaddr type incompatibility; using primary transport dependency versions avoids that without source edits. One initial combined SQL test exceeded Vitest's default 5-second test timeout; the harness uses 60 seconds for local SQL setup, as existing integration tests do. No assertion or security bound was relaxed.

Final validation: strict transitive TypeScript and **20 offline tests passed, none skipped**. These comprise nine generation, seven execution, three identity/runtime/grading and one integrated snapshot test. Acceptance and characterization cases are explicitly named.

Remaining gates: parent fixes and regression conversion for the three findings; durable production approval/budget/replay/report authorities; snapshot identity/capture and crash recovery; bound row-level collateral and attack/control exposure contracts; secret lifecycle integration; authoritative settlement receipts; secured A/B media composition; hosted SQL isolation and live bounded provider acceptance under separate authorization. No writeful full-success, live security, production isolation or deployment acceptance is claimed.

## Parent remediation

The three bounded findings above are fixed in the integrated source. Generation accepts a current-secret getter (or refreshed array), retains observed secrets and screens before dispatch and after output/gate completion. Target output refreshes secrets under the existing deadline and retains ambiguous accounting on refusal. Simulator input is detached before its first await. The original three characterizations now assert safe behavior; two additional generation tests cover rotation during binding and measured-cost preservation on rejected output.

Parent verification: strict TypeScript and 22 security tests passed; current-A integration passed 13 tests; current-A stateful grading passed 29 tests. These are local/offline checks, not hosted acceptance. Trusted snapshot, permission, accounting and runtime authority requirements above remain.
