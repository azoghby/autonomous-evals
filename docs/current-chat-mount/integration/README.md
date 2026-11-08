# Current job chat mount owner patch

Apply `owner.patch` after the exact current-autonomy candidate has been staged. `apply.mjs` exports `applyMount(stage)` and refuses baseline candidates, wrong parents, and changed UI preimages. `PREIMAGES.json` pins both before and after bytes at parent `039851736eabb94e85c2c111bbccc78374716275`.

The patch mounts the existing `JobPrivateChat` inside the current `JobView` primary content column, after its report/progress content. It uses the existing panel styles and column sizing. The existing clarification, quote, report, legacy timeline and activity branches are unchanged. No rich data is synthesized into the legacy timeline. Rich persisted progress, when present, is read independently by the existing authenticated chat endpoint; legacy-only jobs retain the existing timeline and chat snapshot fallback.

The chat only renders after the existing job API succeeds and the returned job identity matches the requested route. The route keys `JobView` by job ID so navigation remounts the fetch/live hooks; chat is additionally keyed and bound to the returned, matching `job.id`. Loading, missing-job and authentication failures do not mount chat. Revocation, retries and response validation remain the existing component's responsibility, with reviewed privacy corrections applied separately by the integrator.

The existing server contract permits the customer owner or an authorized operator to view a job; each private conversation is scoped to the actual authenticated subject and job. The browser supplies only the job ID, never a customer identity or authorization claim. The chat route independently rechecks session/job access on every read, poll and write. The UI mount does not expand server authorization.

Only `apps/web/src/components/app/job-view.tsx` and `apps/web/src/app/(app)/jobs/[jobId]/page.tsx` change when applied. There is no chat payload in server-rendered page props, no public/share/marketing import, no global style change, and no sandbox change. The app/core files in this worktree are not modified: this directory contains the reviewable owner patch.

Verification results belong in the parent current-chat-mount report. This patch directory alone does not claim browser, visual, provider or production verification.
