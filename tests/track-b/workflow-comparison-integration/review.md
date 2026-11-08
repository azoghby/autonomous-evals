# Independent authorization and replay review

Scope: offline source review of `app/files/apps/web/src/server/rich-comparison.ts`, core rich comparison factories, and pinned Track A monitoring/authentication seams. No ECC, provider, network, secret, migration or deployment operations. Review is not production PostgreSQL concurrency or live billing evidence.

Initial findings sent to implementation owner:

1. **Complete inventory authority.** The reviewed core suite and admitted binding both contain twelve cases. A second canonical application inventory source must be checked before dispatch; `scope: base12` alone must never authorize an augmented job with omitted appended cases.
2. **Monitoring payment authority.** `mode: monitoring` must require an active, tenant/job/environment-bound subscription rather than allowing the optional subscription argument to be absent.
3. **Budget authority.** Operator JSON budget caps must be bounded by canonical application job/monitoring policy. A positive integer alone is not an authoritative spending limit.
4. **Retained baseline association.** Full-artifact SHA-256 binds replay, but admission must also verify original retained run/version/target/branch association. Assigning a baseline label to an arbitrary artifact is insufficient.

Verified in initial coordinator source:

- SQL ownership and environment are checked before replay lookup. Payment and job lifecycle checks repeat on reads and target dispatch authorization.
- The application tick identity includes tenant, job, environment, full binding digest, request, and subscription. A durable nonexpiring `PostgresTextCheckpointStore` claim precedes factory construction and all target execution.
- Core `createComparisonMonitoringService` additionally binds complete suite and retained canonical full-artifact digest before separate baseline/current claims. Its dispatch claims never expire; ambiguity requires reconciliation.
- Monitoring retains the original baseline, reuses the same reviewed frozen suite, does not mutate frozen prompts/version fields, and stores full rich results and alert drafts rather than a boolean projection.
- Pending/ambiguous ticks do not redispatch. Failed target execution does not reset claims. Application result reads remain private server-side checkpoint reads.

Production route/transport wiring and fixes to the initial findings require follow-up review after source is complete. No automated acceptance result is claimed by this note.

Follow-up inspection of production wiring:

- Initial findings 1–3 are addressed: `comparisonProduction.verify` reads the canonical application `Suite` inventory; app authority compares that full inventory with admitted inventory and reviewed suite before dispatch; mode/subscription relation is enforced; job cap is bounded by `JOB_BUDGET_MICRO_USD` and monitoring gets an additional tick cap.
- Configuration checks now run within `verify` on every authority resolution, including completed replay and private reads, using canonical endpoint configuration plus credential ciphertext digest.
- Text retained baseline association is checked against the original retained rich artifact and completed `run_identity.targetVersion`; Calendar checks retained branch and version. Core full-artifact digest remains bound to tick replay.
- Routes reuse Track A `requireCronAuth` and customer session ownership. Cron operation IDs are deterministic for subscription and UTC day, sends remain zero, and responses report draft-only notifications.

Further findings sent to owner:

5. **Calendar frozen system prompt.** Production Calendar resolve omitted `systemPrompt`; `platformTarget` does not consume endpoint `systemPrompt` itself. Retained baseline with a system prompt would therefore be compared against a current execution without that prompt. Pass the original retained `run.systemPrompt` identically for both sides or explicitly refuse unsupported prompts.
6. **Concrete reconciliation/admission.** A reconciliation table and comments alone do not implement an authoritative reconciliation seam. Owner-callable code must authenticate the operator and validate retained checkpoint identities/evidence before accepting completion; it must never reset an ambiguous dispatch claim. Admission must likewise be a concrete validated publication path, rather than arbitrary JSON inserted by hand.

Final source review after owner fixes:

- Frozen Calendar `retained.run.systemPrompt` is now passed unchanged to rich Calendar services. Initial prompt finding is fixed.
- Concrete authenticated operator routes now publish insert-only bindings and record reconciliation against locked authoritative checkpoint rows. `accept_retained_completion` requires an already completed application tick; neither route releases a dispatch claim. Reconciliation intentionally records disposition rather than making an ambiguous operation executable.
- Text baseline configuration/version correspondence is now recomputed with the original revision/ciphertext hashing algorithm; current version must equal current configuration digest. Historical configurations that are unavailable after credential deletion/rotation fail closed.

Two final findings were sent to owner for resolution or explicit limitation before handoff:

7. **Existing Calendar version compatibility.** Original Workflow producer saves Calendar `versionLabel: default`. Production verification requires baseline version to equal the original target configuration SHA-256 and also retained Calendar `run.versionLabel`; those requirements cannot both hold for those original artifacts. Core retained Calendar validation also forbids silently relabeling the evidence. Historical Calendar artifacts need an explicit compatibility/new-baseline contract or must be refused with that limitation disclosed.
8. **Calendar reproduction budget holds.** A sequence counter created within the Calendar resolver resets on original run/investigation resolution. Outbound reservation identities can repeat between original dispatch and reproduction. Keep the counter across the Calendar factory lifetime, outside resolver calls, to ensure separate holds for each complete call.

Additional practical limits: per-target reservation amounts are reviewed policy exposure holds, not measured provider costs or proof of a remote provider spend ceiling. Actual server PostgreSQL concurrency, abrupt worker kills, billing/provider receipts and deployment were not exercised by this review. The implementation owner owns automated SQL and applied-source test evidence.
