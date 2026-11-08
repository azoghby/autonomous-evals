# Private chat replay and evidence review

Review checkout: `7f492e2cba2004eca4aeff13752a9380f602f2dc`. Exact candidate parent: `039851736eabb94e85c2c111bbccc78374716275`; supplied read-only stage and source hashes are retained in `candidate-RESULTS.json` and `CANDIDATE-PIN.json`. The tested client SHA-256 is `5edecb09d3d9c6b4f920d570af78c4f5b9b2ce99f55ced563a1764a2260c456b`.

Candidate client: **16 tests passed**. These execute the actual candidate component in React/jsdom with controlled fetch responses. Nine existing interaction tests and four existing reauthorization regressions are reused without modification; three independent new tests cover late history/poll/send responses after switching jobs, inert rendering of HTML and evidence URLs, and polling suppression plus empty cursor restoration after access denial. The historical immutable composed release also passed the same 16 tests, recorded separately in `RESULTS.json` / `client-tests.log`. Source is copied unchanged; automatic JSX transformation matches the app's JSX runtime. No browser was used.

**Release remains blocked:** the integration candidate explicitly reports `chatClientMounted=false`. A component passing isolated tests does not establish that the private chat is reachable from authenticated current job pages. The checked-in review checkout does not yet contain applied chat/server/structured-progress files. Do not describe these artifact checks as deployed chat acceptance.

## Current live-progress defect and owner patch

The actual current `apps/web/src/lib/client/use-live-job.ts` retains private progress when its `jobId` changes or reads are disabled. A late old subscription failure also starts old-job polling after the new job activates. Its subscription callback checks a shared `active` ref: cleanup sets false, but the next job sets true, allowing a late old subscription callback to overwrite the next job's snapshot. Four strict regressions fail on unchanged current source and pass after applying `use-live-job-isolation.patch` only in a disposable app-shaped fixture. `HOOK-RESULTS.json` pins the original and patch hashes; both logs are retained. No app source was edited.

Minimal reproduction: render a consumer for job A; call its live subscription `onRows` with private progress; rerender the same consumer for job B before B returns anything. A's text remains. Deliver B's rows followed by A's retained callback: A's rows replace B's. Rerender A with `enabled=false`: loaded A rows remain. The patch resets the snapshot when the effect's job/enabled scope changes and fences live callbacks using a closure-local stopped flag, including failure and live-status callbacks. It preserves the existing polling cleanup guard. This demonstrates a reusable-hook defect; current mounting/keying may limit reachability in a particular page. Owners must apply and verify against their exact candidate. There is no hosted disclosure claim.

## Evidence and progress inventory boundaries

The chat component renders reply strings as text and never turns opaque evidence references, supplied URLs or input digests into navigable evidence/report links. Cross-user/job report artifact access is reviewed separately by the parent against current routes. A plain-text evidence URL does not establish authorization of the target resource.

The candidate structured projection requires an owner/job/environment inventory for non-trace packages, validates checkpoint job IDs and format, pins revision/plan/observation time in the request transaction, rejects missing/stale inventory and merges only bounded safe app costs with `unknownCosts=true`. Trace audits use the bounded app projection. These are code-review observations; the authority child executes the actual SQL and structured routes. Current legacy `/progress` remains a separate milestone/message projection, not proof that the structured inventory has been produced for each deployed job. Rich/paid artifact availability, current producer registration and migration/grant application need explicit owner evidence.

## Offline reproduction and remaining hosted checks

From the review root, using retained dependencies (no installation):

```sh
node tests/track-b/chat-current-authority/privacy/run.mjs
node tests/track-b/chat-current-authority/privacy/run.mjs /absolute/read-only/candidate
node tests/track-b/chat-current-authority/privacy/hook.mjs
```

The hook runner requires the expected baseline failures and patched success; it does not weaken the assertions or modify the original source. The client runner accepts a candidate path and records its actual source digest. `CHAT_UI_NODE_MODULES` can point to an existing dependency tree; the default is the retained `/tmp/progress-chat-ui-verification/node_modules` cache.

Remaining owner checks: mount the candidate chat on real running/delivered job surfaces; authenticated hosted owner/other-user/operator/public access; session expiry/revocation while requests are outstanding; current credential/key rotation; PostgreSQL independent-connection revocation and pinned snapshot semantics; real inventory migrations, grants and producer watermarks; authenticated evidence/report downloads after ownership changes; transport/cache behavior and real Workflow recovery. Scripted fetch/session fixtures do not establish hosted authentication or customer isolation. No secrets, providers, external services, cloud changes, spend or pushes were used.
