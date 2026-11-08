# Workflow appended-pack integration handoff

Concrete, ordered application patches only. All repository changes live under
`docs/workflow-pack-integration/**`; production app/platform/contracts/manifests
and core are untouched. ECC disabled. The two requested implementation children
were integrated, with parent fixes for draft-report preservation and simultaneous
failure/coverage-gap handling. No cloud/provider calls, secrets, spend, outreach,
install, push, PR or deployed migration occurred.

## Exact application order

[SERIES.json](SERIES.json) pins both source commits and SHA-256 of every input
patch. Start with the **Track A archive** at
`f0068733ca49c37f40fd7de279325f21a4b5fbbb`, not this Track B checkout.

1. Apply `docs/progress-chat-integration/combined.patch` once.
2. Overlay the seven core directories listed in SERIES from
   `48519bf16e04bce3397ceaeb8abea060d2636263`. Preserve Track A redteam, contracts,
   integration and DB sources. This pin includes `c63a67a`; staging checks ancestry.
3. Apply `docs/structured-progress-integration/backend/structured-progress.patch`.
4. Apply `docs/workflow-integration/service-bootstrap/0001-rich-service-bindings.patch`.
5. Apply `docs/workflow-integration/workflow-producers/002-workflow-producers.patch`.
6. Apply [003-pack-projection.patch](projection/003-pack-projection.patch).
7. Apply [003-pack-execution.patch](execution/003-pack-execution.patch).

The two `003` filenames have distinct directories; projection precedes execution.
Run `node docs/workflow-pack-integration/stage.mjs` for offline hash verification,
archive composition and sequential `git apply --check`/apply in a disposable
folder. It creates no shell worktree and changes no production source. The root
stage rejects changed predecessor patches rather than silently testing a new base.
Do not apply this series twice or stack it blindly over another team's patches.
The data-bridge and remediation-integration artifacts were not changed or composed.

Deploy the existing core/Workflow migrations through the owner's normal process,
then the execution patch's `apps/web/migrations/003-workflow-packs.sql`. The new
approval table must remain private. No runtime DDL or customer approval grants.
This is an integration artifact, not a deployed release claim.

## Implemented behavior and authority

The rich text path designs/admit-freezes the original twelve independently.
Appended cases never enter base12 execution, investigation or remediation. An
explicit authenticated operator first previews the full ordered appended selection
and source-rule references against the retained base digest and actual resolved
target configuration, then approves that exact content digest. The server issues
reviewer/timestamp and persists one immutable approval per job. See the complete
[operator JSON contract](execution/README.md#authenticated-operatorsource-rule-contract).
Intake/model output cannot issue approvals, reviewer receipts or trusted specs.
The operator's decision authorizes the named source rules for the job; those IDs
do not manufacture upstream policy authority.

The registry and single-rule adapter import the actual pinned A library and
`gradeRedTeam`, retaining its leading/anywhere, base64 and separator semantics.
The existing secured target and core pack execution service/checkpoint store are
reused. The stable `pack:<jobId>:baseline` identity survives fresh Workflow runs;
changed input conflicts and pending/ambiguous dispatch cannot be redispatched by
choosing a new identity. Approval, tenant, environment, current Workflow and actual
target binding are rechecked by the execution/report composition root.

The manifest and durable report retain the **complete operator-approved selection**,
including unsupported and unknown IDs. This is not an automatic claim that all
20 default selector cases were chosen: that requires approving all 20 IDs in
order. Only `rt_inj_direct_fake_system` and `rt_jb_dev_mode` support v1 execution;
all unsupported semantics and unknown IDs remain explicit quarantines. Runtime
unavailability and incomplete evidence remain unknown/quarantined, never pass.

The immutable private envelope retains base suite/run/investigation and full
`appendedPack` manifest/results separately. Authenticated tenant/environment-bound
`evidence`, `pack-progress`, markdown and HTML report downloads preserve this scope.
Report prose and progress use validated IDs/statuses; raw rules and response
quotes stay private. Missing evidence is unavailable/unknown. A draft report is
saved before incomplete coverage stops delivery. Every case is checked: failure
precedence cannot hide simultaneous quarantine/unknown coverage. Existing chat
progress does not certify pack completion.

## Comparison, remediation and remaining boundaries

Use the COMPLETE retained artifact for baseline `{runId,digest}`, including both
scopes, manifest and private investigation. A changed artifact requires a new
monitoring/comparison tick identity. Retrieve authorized durable pack reports and
use core `comparePackRuns` with the historical pinned registry; retain its union
of expected IDs and unpaired reasons alongside the independent base comparison.
The patch supplies the full-artifact identity helper and report warning, not a
new comparison or monitoring Workflow.

Base12 repairs cannot certify appended cases. Pack remediation requires a newly
reviewed actual patched target, fresh authorized execution under an explicitly
designed lifecycle, and complete retained pack evidence. This baseline adapter
cannot reset its immutable approval/run identity to perform remediation. Calendar
appended semantics remain blocked. Missing review pauses after retained design
and before base target execution; owner-authorized resume/wakeup remains required.
Replacing a retained unresolved private snapshot needs an owner-designed revision
lifecycle; never evade dispatch fences with a replacement run ID. Later parent
core fixes need explicit rebasing/revalidation, retaining the frozen-input fix.

## Validation

Run with existing offline dependencies only:

```
WORKFLOW_NODE_MODULES=/absolute/existing/node_modules \
WORKFLOW_INSTALLED_WORKSPACE=/absolute/existing/pinned-app-workspace \
node docs/workflow-pack-integration/verification/validate.mjs
```

[Combined validation log](verification/combined.log): **54/54 tests in eight files,
none skipped**, complete core/app strict TypeScript, actual Next route generation
and Workflow compilation (**47 steps, one workflow**). Tests execute applied source,
actual pinned grader, authenticated operator route, PGlite checkpoint/approval and
private artifact SQL, rich-step wiring and authenticated artifact downloads.
They cover authority/revocation, target/tenant drift, restart/ambiguous fencing,
quarantines, unknown checks, separate evidence, baseline digest, secret refusal,
and failure with simultaneous coverage gaps. Target transport is an in-process
fake. No hosted DB, provider, deployment, broad SQL/build sweep or live acceptance
is claimed. The final root hash/order staging check also passed.
