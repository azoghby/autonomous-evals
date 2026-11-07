# Independent Track B calendar integration review

Reviewed committed source `19580d2fde4406fd9237722dc97542d315e68276` on November 7,
2026, including calendar service commit `b5681ce` and report adapter commit
`cd65717`. Read calendar integration, workflow, workflow persistence and text
integration/checkpoint documentation and implementations. One focused Sol child
reviewed reporting; the parent reviewed authorization, claims and replay.
Only this document and `tests/track-b/calendar-integration-review/**` are owned.
No production code or existing engine tests changed. No ECC, network/provider,
cloud, spending, outreach, push or PR work was performed.

**Parent fix update:** the two defects and trusted-projection defense gap below are now fixed. The 20 review tests assert corrected behavior and pass strict compilation, with none skipped. Calendar requests are detached and validated before claims; system-prompt limits are also checked before dispatch. Report timestamps are validated and secret-screened. Confirmations require matching original/reproduction scope, outcomes, reasons and failed checks; missing/inconsistent evidence rejects, and unresolved reproductions remain unresolved even without findings. The original findings below are retained as historical evidence, not open defects. The recorded console files predate these fixes.

## Findings and proposed minimal fixes

### P2: invalid version permanently consumes a stable operation before dispatch

`packages/core/src/evals/calendar-integration/index.ts:133` calls `operation`
before `runCalendarSuite` validates `versionLabel`. The operation commits its
claim at line 89, then catches deterministic validation errors and marks the
phase ambiguous at lines 97–99. Caller-reachable reproduction: freeze a valid
suite; run with the stable operation ID and `versionLabel: ''`; retry that same
ID with `baseline`. The first call returns `needs_operator` and retains an
ambiguous checkpoint; the corrected call also blocks on digest conflict. The
target was called zero times. No database mutation/import is involved.

This unnecessarily requires manual reconciliation for a provably undispatched
request. It is an availability/error-classification bug, not an authorization
bypass. Validate a detached request (suite/operation IDs and version label using
the engine's constraints) before claiming, return `rejected_input` for invalid
requests, and keep the existing conservative fencing after dispatch becomes
possible. Do not release ambiguous claims or recommend changing operation IDs
to bypass them. Reproduction: service test `CHARACTERIZATION: invalid version…`.

### P2: generatedAt bypasses report credential rejection

`packages/core/src/reporting/calendar.ts:18` scans job, report and costs, omitting
`generatedAt`, which is passed through to the renderer at line 43. On an actual
fresh-service report, call the public renderer with
`generatedAt: 'ReviewKnownCredential4239053'` and that same string in
`knownSecrets`. Rendering succeeds and publishes the credential in JSON,
Markdown and HTML. The timestamp is an unconstrained string at this API.

This requires a caller mistakenly putting a credential in metadata; it is not
customer control over an authenticated route or evidence of real credentials
being exposed. Still, the explicit known-secret rejection guarantee does not
cover all emitted fields. Validate timestamp syntax before rendering and include
all output metadata in the existing credential check. Reproduction: report test
`DEFECT: generatedAt…`, using a synthetic secret only.

### Trusted-projection defense gap: confirmation ignores actual reproductions

`packages/core/src/reporting/calendar.ts:19–42` validates some original finding
associations but derives `reproduced: true` solely from status/count and accepts
the supplied reproduction scope without joining it to rich investigation
results. It also computes status from original executions, finding labels and
pending IDs without examining actual reproduction outcomes.

The report tests first obtain a genuine report through fresh services, then
mutate detached trusted projections, separately demonstrating:

- Removing all reproduction results still emits confirmed/reproduced/completed.
- Changing an actual reproduction to infrastructure_error still emits the same
  confirmation and completed status.
- Supplying a reproduction scope for a different job emits that invented run ID
  as reproduced.
- With zero findings and an infrastructure reproduction, status is completed
  and the summary says “No problems”.

**These are trusted-report consistency probes, not demonstrated service-produced
states, database corruption exploits or customer authorization bypasses.** The
honest current service and engine produced consistent evidence in this review.
Nevertheless confirmed labels must not mask mismatched reproduction evidence at
this reporting boundary. Minimally validate findings against investigation
findings, join each attempted reproduction by scenario and full scope, verify
job/version/scenario associations and matching objective failure evidence before
emitting confirmation, and reject inconsistent projections (or explicitly mark
them unresolved). Include unresolved reproduction outcomes when deriving status,
even when findings are empty. Do not infer reproduction from a claimed count.

## Verified properties and limits

The service tests execute actual simulator, SQL grades, journal table/CAS and
checkpoint SQL in PGlite. Every restart constructs a fresh service, checkpoint
adapter and (on investigation) journal adapter, sharing the durable fixture DB.
Full frozen suite, original run, three bounded reproductions, findings, transcript
messages, state/check results and report JSON match after fresh-instance replay,
with no extra target calls. Completed output is detached through JSON storage.

Customer, target version, branch, prompt and review timestamp drift reject saved
replay. Environment mismatch rejects, and the same operation ID cannot be reused
with a different suite/version. Resolver authorization runs again for saved reads,
run replay, investigation and report preparation; withdrawing authorization
prevents access without target dispatch. No cross-tenant authorization exploit
was found under the documented trusted resolver/checkpoint model.

A target-blocked run exposes a committed pending claim before completion and
competing fresh services cannot dispatch. A committed claim with lost
acknowledgement leaves pending evidence and causes zero dispatch. Investigation
completion loss preserves the full journal's original and three completed
attempts: committed completion replays, while uncommitted completion fences
investigation and reports. These tests inject acknowledgement failures through
the store interface; they do not corrupt trusted rows.

Report probes confirm original infrastructure/inconclusive executions and pending
reproductions prevent clean status even with zero findings. Normal rich report
secrets reject. HTML escapes target-controlled script text and Markdown fences
backticks/link payloads. Full evidence remains in report JSON; costs stay unknown
when no measured list is supplied.

The resolver must authorize physical dependency closures and provide stable
customer/target identities; the factory cannot introspect database/target
closures. New operation IDs intentionally permit new evaluations and must not be
used to bypass ambiguity. Whole-investigation fencing after lost completion,
absence of automatic recovery, and inability to recover missing external evidence
are documented architectural limitations. No separate data-store implementation
or active text-design admission review was attempted.

PGlite advisory functions are intercepted, so this is not native PostgreSQL
multi-session locking, process-restart/crash durability, cloud integration or
exactly-once external execution proof. Fresh services share a live fixture engine;
no native service restart is claimed. All targets are local deterministic fakes.

## Reproduction and validation evidence

Install cached dependencies if necessary:

```sh
npm --prefix tests/track-b ci --offline
node tests/track-b/calendar-integration-review/run.mjs --track-a-ref c4bd22e177a6b14ecd9b505033b3a27dbdb0b061
npm --prefix tests/track-b run check -- --components evals,simulator,reporting --track-a-ref c4bd22e177a6b14ecd9b505033b3a27dbdb0b061
```

The isolated review runner copies production source without modifying it, stages
only these review tests, reads contracts from the exact local Git revision,
runs strict TypeScript, and rejects missing/skipped/todo/failed review files.
It does not fetch contracts or run providers. The selected existing harness stays
unchanged. Local contract digest is
`67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`.

Final review: strict TypeScript and **20/20 tests in 2 files**, none skipped.
Selected existing checks: strict TypeScript and **467/467 tests in 35 files**,
none skipped. Committed console evidence is under the review directory.

Initial review development runs failed strict typing on three test fixture field
names/types, then a report fixture expected three failures but selected a
no-op-safe conflict scenario (only two failures), then an assertion overlooked
Markdown escaping of hyphens in the synthetic credential. The fixture and
assertions were corrected; these were review-test errors, not production defects.
No existing tests were changed to obtain green results.
