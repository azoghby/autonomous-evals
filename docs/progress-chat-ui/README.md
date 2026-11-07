# Track A progress chat UI handoff

`track-a-progress-chat.patch` applies to **07cf5dfe811de25ce31c4ed1ac05cb3b4a1f5b4f** (the inspected `origin/track-a`), with chat service contract from **ce4d2830ad467816d1ed4ed16c3366b5a2b67633**. This commit contains patch/docs/verification artifacts only. Track A application files, root configuration, parent cost/session/SQL/redaction/calendar changes and the failed checkout remain untouched.

The patch adds `apps/web/src/components/app/job-progress-chat.tsx` and `apps/web/src/lib/client/progress-chat.ts`, and mounts the panel in the real `apps/web/src/components/app/job-view.tsx`. Existing clarification, progress timeline and report flows remain in place. The panel uses the existing cream/coral tokens, `Block` and `Textarea`; it has a bounded scroll region, wrapping text, labeled composer, visible keyboard focus, polite announcements, loading/empty/error states, forward history pagination and 3-second nonoverlapping polling. Persisted replies carry freshness, unknowns and opaque references rendered as text. Questions are held only in tab memory. Ambiguous send retries reuse the same ID and input. Requests are aborted and stale results discarded on job/session changes or access loss.

## Apply and connect

Track A owner should review then run from a checkout at the exact baseline:

```sh
git apply --check /absolute/path/to/track-a-progress-chat.patch
git apply /absolute/path/to/track-a-progress-chat.patch
```

Rebuild and verify the artifact without changing the checkout:

```sh
python3 docs/progress-chat-ui/build-patch.py
```

**The default panel says chat is not connected and exposes no composer. No API URLs or production routes are invented.** After implementing the trusted adapters and dedicated authenticated handlers described in [auth-review/INTEGRATION.md](auth-review/INTEGRATION.md), wrap the existing authenticated client shell with `ProgressChatTransportProvider` from `@/lib/client/progress-chat`. Supply a stable `ProgressChatTransport` value whose methods explicitly bind to those handlers. The existing JobView reads that context and remounts the panel using job ID plus `authScopeKey`.

The provider must replace/clear its value whenever the verified session changes or expires, including logout and account switching. `authScopeKey` is an opaque UI lifetime marker, never a trusted browser identity or request credential. Do not derive it from the viewed job owner. Avoid recreating the transport on every render. Each method receives `jobId` and `AbortSignal`; adapter code must validate response shapes, impose timeouts, normalize fixed errors to `ProgressChatError`, and use same-origin credentials and no-store. Server authentication and job authorization remain mandatory on every operation. No client storage or logging of raw questions should be added.

`ChatPoll.activity` is an **optional UI adapter extension**, absent from the completed service. It must be supplied on each poll only from an authorized persisted projection with recorded timestamp and evidence IDs. Its kinds are `acquiring_data` and `waiting_for_expert`; omission means detailed status unavailable. Do not infer these states from `investigating`, open invitations or arbitrary progress text. An unchanged service poll may omit `reply`; the UI retains the prior snapshot. Poll replies never become conversation entries.

## Precise remaining production blockers

Track A still needs durable `(subject, job)` conversation storage with transactional idempotency/sequences; a complete customer-safe persisted progress projection and consistency watermark; opaque authorized evidence IDs; and authoritative acquisition/expert-waiting semantics. Existing clarification `/messages` can resume Workflow and must remain separate. These missing adapters/schema semantics prevent a responsible production endpoint patch. The UI is concrete and injectable, but production chat is not enabled by applying this patch alone.

## Verification

- Patch check, application and byte-for-byte output comparison passed against the immutable Track A baseline (three source files).
- Isolated fixture: strict TypeScript passed; **15 interaction tests passed**, including send/retry, Unicode input bounds, history pagination, errors, no raw exception leaks, literal text rendering, cursor polling, waiting states, 401/404 clearing, late-response cancellation, and verified-session provider replacement.
- Fixture versions are pinned in `verification/package.json` and `package-lock.json` (React/React DOM 19.2.0, TypeScript 5.9.3, Vitest 3.2.4). Track A declares React 19.3.0 and Next 16.4.5. This is **component verification**, using explicit `Block`/`Textarea` and date formatter interface doubles; it is not a full Next build or proof of Track A dependency compatibility.
- Isolated copy of the existing Track B harness, with completed backend chat files from ce4d283 staged only in that fixture, passed strict typechecking and **45 tests** for `--components reporting --track-a-ref 07cf5dfe811de25ce31c4ed1ac05cb3b4a1f5b4f`. Contract-schemas was excluded as requested. No source/lockfile in the parent was changed. Initial clean dependency installation hit `Missing: track-b@ from lock file`; the run used the already-installed harness dependency directory at `/tmp/autonomous-evals-checks.m10du4/node_modules` (Vitest 5.1.0).
- No browser tools, screenshot inspection, desktop/mobile layout verification, full Next application run, production handler/database tests, deployment or provider calls were performed. Responsive/focus/contrast behavior needs rendered verification by Track A after connection. No claim of rendered verification is made.

Reproduce the isolated component checks (run from repository root; source never written there):

```sh
ARTIFACTS="$PWD/docs/progress-chat-ui"
FIXTURE="$(mktemp -d /tmp/progress-chat-ui.XXXXXX)"
cp "$ARTIFACTS"/verification/* "$FIXTURE"/
cd "$FIXTURE"
npm ci --ignore-scripts --no-audit --no-fund
node prepare.mjs "$ARTIFACTS"
npm run check
npm test
```

After parent integrates the backend, its existing reporting harness command is:

```sh
node tests/track-b/run-checks.mjs --components reporting --track-a-ref 07cf5dfe811de25ce31c4ed1ac05cb3b4a1f5b4f
```

Two independent Codex child agents supplied disjoint component and authorization-review artifacts; parent integrated the provider seam, mounting patch, rebuild/apply checks and interaction fixture. Design standards were read first. ECC was off throughout.
