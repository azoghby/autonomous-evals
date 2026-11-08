# Composed chat / structured / Workflow UI corrections

Owned artifacts only; production and original deliverables remain unchanged. Apply
`restore-history.patch`, then `next-esm-compatibility.patch` to the composition
specified by `docs/workflow-integration/SERIES.json` at
`5f513d14f0898029a5cc188d75ff9a489bc47651`. Apply the server compatibility artifact from `a54ab05341856eb59a42f1e204a6cf89df19356b` after the Workflow producer patch and before these UI patches. Both UI patches are byte-for-byte
restored from `d7cd083fe9c8ea3e810277ef2fc8fa5887693fa5` and pass `git apply
--check` over that composition. The first restores history cursors on revocation,
suspends blocked polls and rejects stale poll/send responses across access
restoration. Stable send identity/text retry behavior remains intact. The second
selects production webpack, maps Node ESM `.js` imports to TypeScript sources,
and preserves Tailwind processing with the existing loader. Development requires
explicit `next dev --webpack`; default Turbopack development is not verified.

`source/job-private-chat.original.tsx` is the full uncorrected d7cd083 client;
`source/job-private-chat.tsx` is the full client after applying the history patch.
Integrate the patch over the existing client, rather than adding a second chat.
The adapted original tests and runners live in
`tests/track-b/chat-workflow-release/ui/`. Exact historical scripts are retained
in `provenance/` for inspection, **not execution**: the historical compatibility
script installs dependencies and is outside this run's authorization.
`provenance/prior-RESULTS.md` describes the old run, not the current composition.

## Reproduction without installation

```sh
node tests/track-b/chat-workflow-release/ui/run.mjs
node tests/track-b/chat-workflow-release/ui/compatibility.mjs
# Use the retained stage printed by compatibility.mjs:
node tests/track-b/chat-workflow-release/ui/render.mjs /tmp/RETAINED_STAGE
# Targeted final check on the earlier pre-server archive (no second full build):
node tests/track-b/chat-workflow-release/ui/final-check.mjs /tmp/RETAINED_STAGE
```

The stage runner reads every series patch via `git show 5f513d1:...`, archives
Track A `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, overlays only the series'
listed core directories from `5906961c2a70c0d6d2999cf7086689402ff60f5b`, and
applies chat, structured, rich-service and Workflow producer layers in order, followed by the immutable server compatibility patch.
It never replaces the workspace manifest or lockfile.

`CHAT_UI_NODE_MODULES` chooses the original lightweight interaction cache
(default `/tmp/progress-chat-ui-verification/node_modules`).
`CHAT_APP_CACHE` chooses a retained installed app archive (default
`/tmp/workflow-bootstrap.JpxCTM`). Its lockfile must match before copying
node_modules, including web-local dependencies; relative workspace symlinks then
resolve into the disposable composition. No install or fetch occurs. Missing
packages or a mismatched lock fail closed. `CHAT_FONT_CACHE` chooses a retained
Next output with Geist CSS and woff2 files; the default is recorded in the runner.
Next's font test hook reads those local files instead of making Google requests.
This tests the application with real retained fonts, but is not a clean uncached
font acquisition check. The build/dev processes inherit an outbound socket guard
and a minimal environment. The browser aborts non-local requests.

`CHAT_UI_OUTPUT` changes app evidence output; `CHAT_UI_STAGE` resumes a previously
prepared disposable archive using its existing evidence summary. No second
install or source checkout is made. Stages are retained for the integration owner.

## Current results

See `RESULTS.md` and `evidence/summary.json`. Release acceptance remains false.
No authenticated database/session, cross-user storage, deployed Workflow producer,
provider invocation, migration, or deployment is verified here. No secrets,
cloud calls, installs, push, PR, or production edits were made.
