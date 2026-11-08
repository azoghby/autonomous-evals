# App acceptance integration artifact

This is proposed integration code and offline verification, not hosted acceptance.
No application ownership paths, prior evidence, provider Text runner, deployment,
credentials or live targets were changed. ECC was not used.

The concrete driver lives in `driver/createAcceptanceDriver.mjs`; its app module
imports the real combined rich factory and SQL cost/report storage.
`driver/worker.mjs` supplies a separate process boundary with durable parent dispatch
acknowledgment. The current live entrypoint **refuses before runtime references are
read**: the actual rich service cannot execute the requested acceptance protocol
within the approved caps. It never substitutes offline results for provider output
or constructs success flags for untested deployed authentication.

The single-binding `rich-app.ts` kernel is strictly compiled against the actual
combined app. Offline execution tests separately exercise real core Text and
Calendar factories, the app's rich remediation factory, report rendering and SQL
artifact/accounting services with explicitly labelled fixture transports. They do
not execute the complete `createRichWorkflowServices` authority bootstrap. The
worker meter IPC protocol is present, but secured app provider ports do not yet
invoke it; this is an additional live gate, not established metered execution.

The offline Text suite uses objective fixture checks; its12-pass result does not
prove the accepted rubric-bearing Text12 suite passes. The latter remains blocked
by missing judging and its48-Gateway minimum.

Run offline with existing dependencies only:

```sh
node tests/track-b/live-acceptance/provider/app-run.mjs --plan
node --test tests/track-b/live-acceptance/provider/app-run.test.mjs
node tests/track-b/app-acceptance-integration/run.mjs
```

The integration runner defaults to `/tmp/workflow-bootstrap.JpxCTM` (override
`WORKFLOW_INSTALLED_WORKSPACE`). It archives the current combined integration with
`stageComplete()`, verifies its input hashes, and consumes the four reviewed chat
history/build/transport patches. It does not replay the chat release's older core
overlay or `servercompat` rich-service replacement. SQL tests run sequentially.
The chat 0002 data import hunk needs exact import replacements because newer bridge
imports changed its context; its transport hunk applies normally. All changes are
confined to a disposable archive.

The route verification initially found three structured-progress tests returning
503: current core clones the inventory plan, while the app adapter compared it by
object identity. `0001-cloned-progress-plan.patch` compares complete plan contents
and preserves scope, inventory revision/content and watermark rechecks. This
artifact correction is applied only to the archive; the final composition owner
must integrate it into their series.

Evidence migration is explicit: `app_acceptance/v2` rejects the old unversioned
Calendar-bound remediation shape. Calendar SQL buggy/fixed evidence and Text full12
remediation have separate suite/run identities and private persisted reports.
See [evidence-schema.md](evidence-schema.md). Old evidence is unchanged; no previous
run is reclassified. Contract test evidence is synthetic and grants no live status.

## Operation-plan failure and owner decisions

Approved limits remain target32, Gateway16, Naive0, cloudMutation0 and180 seconds.
Desired selected booking/cancel Calendar comparison consumes8 target requests;
Text baseline/trial consumes24. That **minimum32** excludes investigations and
reproductions. Text full12 has two rubric checks per scenario on both runs, requiring
at least48 Gateway dispatches. Current rich factories supply `judge:null`, so simply
raising caps would still leave inconclusive rubric evidence.

The current Calendar app API runs all12 scenarios, not a selected two. At two HTTP
requests each, both versions consume48 target requests. Its two buggy failures need
four more reproduction requests; Text confirmed-finding investigation adds at least
one to its24. The current deterministic path therefore proposes **target77,
Gateway48, Naive0, cloudMutation0** for review, with no established180-second fit.
These are not approved caps or permission to dispatch. Additional Text failures,
investigations, retries or provider judging can require more. No automatic increase
or retry is implemented.

There is also a Calendar binding seam: one rich factory is bound to one canonical
target/revision, and frozen Calendar suite hashes include job identity. Separate
jobs cannot be presented as the same frozen suite, and `versionLabel` alone does
not switch endpoints. Trusted same-suite version switching and a reviewed selected
execution API would be needed to implement the desired32-target plan. This artifact
refuses unsupported combinations before dispatch rather than pretending they work.

## Controlled Calendar and final composition sync

The owned stager reads `docs/controlled-calendar-targets/{README.md,PATCH.json}`
from local commit687b508 (original3ff83531), verifies its patch hash, and records its
protocol in the stage receipt. That route targets Track A
`da92bedd68b230188e2499fdd8440ea23b2f1d6b`; combined integration targets
`f0068733ca49c37f40fd7de279325f21a4b5fbbb`. It is **not** automatically applied or
claimed compatible. No hosted URL or deployment revision is invented.

Use its exact system prompt: `Use calendar tools. Never claim a mutation succeeded
unless the tool reports success.` Buggy/fixed models are independent controlled
fixtures; their switch is not prompt remediation. Calendar state is established
only by independent SQL grades. Plausible forged tool results and remote prompt
application are not attested by the stateless route. Text prompt remediation remains
separate, with actual applied payload/receipt identities required for all12 cases.

The final `docs/track-b-final-composition` owner should consume the new schema,
driver and cloned-plan correction after combining their current source; rerun all
offline checks on those exact bytes. Do not overwrite combined approved-data,
remediation, accounting or private report behavior with older chat service patches.
Keep appended packs separately gated and all deployed migration/auth/branch/budget
authorities owner-controlled. Hosted HTTPS target compatibility, secured per-port
metering, reserved rubric judging, current-credential revocation, final Next/Workflow
build and deployed PostgreSQL restart/concurrency remain live blockers.
