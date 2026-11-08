# Private progress chat: Track A integration artifacts

Patch base: **`96cb4adcea8c55ae4d8cc353deb059996245aa77`**, the locally resolved `origin/track-a` on 2026-11-07. No fetch was performed. This supersedes the older brief's `f28b7a63ec78bbacd5ab7633ccf818a119c99401` baseline. Core reference: local main `6ae4b6f`.

These are reviewable patch artifacts only. No application, production core, manifest, platform ownership, or stale `docs/progress-chat-ui/` files were modified. Nothing was deployed, pushed, migrated against a service, or called against a model/provider.

## Apply in the Track A owner's checkout

1. Review `combined.patch` against the exact base above. Run `git apply --check /absolute/path/to/combined.patch`, then apply it. The combined artifact is the ordered concatenation of `core-security.patch`, `server.patch`, and `client.patch`; apply either the combined artifact or its components, never both.
2. Before enabling chat, apply the separate conversation SQL artifact in `server/` through the owner's transactional migration process. The core migration already exists at the pinned base, but its presence in source does not mean tables exist. Do not run it automatically on a request. Keep tables accessible only to the private application database role, never direct client access.
3. Configure the server-only HMAC reference key and existing application database/encryption settings described below. Deploy via the owner's existing release process after their normal full workspace checks and an authenticated browser smoke test.

The security prerequisite patches the existing core chat service with main's current known-secrets screening for generated replies, immutable replay/history and polling. It is an explicit artifact rather than a silent dependency on a merge of all main changes. It does not add structured checkpoint production wiring.

## Behavior and privacy

Dedicated authenticated `GET` and `POST /api/jobs/[jobId]/chat` handlers do not use the clarification route, workflow hooks, or `resumeWorkflow`. They work while jobs are running and after delivery. Identity is derived from the existing authentication mechanism; every operation scopes the conversation to both caller and authorized job. Public share access does not confer private chat access.

- History: `GET ?afterSequence=0&limit=20` returns `{exchanges,nextAfterSequence,hasMore}` in ascending order. Continue from `nextAfterSequence`. `hasMore` conservatively indicates a full page, so a final empty request is possible.
- Send: `POST {messageId,text}` returns `{exchange}`. The client keeps a stable ID when retrying the same pending message. Reusing an ID with different input returns a conflict. Raw questions are deliberately not persisted; durable history contains grounded answers, sequence numbers and input digests.
- Progress: `GET ?mode=poll&cursor=<previous cursor>` returns `{cursor,changed,asOf,reply?}`. Polling reads persisted progress and creates no conversation exchange or workflow action.

The app adapter maps existing persisted job state, progress events, findings and cost ledger rows into the core's bounded safe snapshot. HMAC references are opaque and scope-bound. Provider payloads, trace content, free-form progress messages, evidence URLs and findings prose are never exposed. Current known secrets are screened before output, including old replies. Failures return fixed safe messages.

Trace Audit is the current truthful path. Structured text/calendar checkpoints are not integrated into this application composition. There is no invented ETA, completion percentage, clean result, or assumed zero total cost. Costs remain explicitly incomplete. Retention/deletion of the new private conversation tables must follow the owner's existing customer-data lifecycle; this artifact does not introduce a new automated retention job.

## Validation

`node docs/progress-chat-integration/validation/validate.mjs` reconstructs the exact base with `git archive` in a disposable temporary directory, checks that the combined artifact equals its components, applies it, and runs core regression/current-policy tests. It never creates a Git worktree, installs dependencies, contacts a database, or calls a provider. Set `CHAT_CORE_NODE_MODULES` to an already-installed offline dependency directory with Vitest and Zod; the local default is documented in the script. Temporary staging is retained for inspection.

Additional server and client checks, exact results, configuration names and limitations are recorded below after integration validation.

## Configuration and durable read boundary

The concrete lazy Neon `Pool` uses the existing `DATABASE_URL` and schema, with a small connection cap and transaction timeouts. The existing integration composition's pool is private; the artifact does not change its ownership or introduce an injectable global service. Existing `CREDENTIALS_ENCRYPTION_KEY` (32 bytes, base64) decrypts current authorized job credentials and GitHub tokens and supplies the stable HMAC key with a private-chat domain label. No new provider configuration or spend is needed. Key rotation changes references and poll cursors.

Projection reads use one pinned `REPEATABLE READ READ ONLY` transaction for job authorization, credential policy and persisted job/progress/findings/cost rows. The app adapter never routes this through Neon HTTP batch queries. Conversation writes use the core port's required pinned `READ COMMITTED` transaction, separate from the read-only projection. The core access port rechecks authorized ownership/operator access before each send, history or poll operation; conversations remain private to the current user even for operators. These separate port transactions do not promise atomic authorization revocation across a request racing a concurrent ownership change.

Findings represent original evaluation findings (`rerun_of_finding_id IS NULL`), matching the current report scope. Rerun histories and structured checkpoint outcomes are not represented. Oversized or invalid snapshots fail safely rather than returning partial counts or a truncated cost ledger. Existing credentials that cannot be decrypted also fail safely. Missing migration/configuration produces safe storage/projection failures; the implementation supplies concrete composition rather than relying on an unimplemented injection seam.

## Recorded result (2026-11-07)

Exact-base archive check and apply: passed. **51 tests passed, none skipped in the selected suites**: 25 core/current-policy/PGlite migration and conversation tests, 17 server route/projection/transaction/composition tests, and 9 React interaction fixtures. Targeted TypeScript checks passed for both the applied client component and server route/adapter with core dependencies. The applied client component matched its source artifact hash.

Commands after the validator prints its disposable staging path (replace `STAGE` and dependency directories with local existing equivalents):

```sh
node docs/progress-chat-integration/validation/validate.mjs
node docs/progress-chat-integration/server/run.mjs STAGE /tmp/track-b-harness/node_modules
node docs/progress-chat-integration/server/typecheck.mjs STAGE /tmp/track-b-harness/node_modules
CHAT_STAGE_DIR=STAGE CHAT_UI_NODE_MODULES=/tmp/progress-chat-ui-verification/node_modules node docs/progress-chat-integration/client/tests/run.mjs
```

Server verification executes the actual applied route, adapter, encryption/redaction and core service, with fixture session and pool boundaries. The targeted server typecheck uses explicit structural declarations for the unavailable Neon SDK/session boundary; it is not a full app or real-SDK compatibility check. PGlite executes the actual standalone migration and core conversation SQL, without PostgreSQL multi-session concurrency or remote connectivity claims. Client tests use React 19.2 with jsdom; the target app declares React 19.3. These limitations are detailed in `server/NOTES.md` and `client/VERIFICATION.md`.

No full workspace build/typecheck, real Neon transport test, authenticated live endpoint test, screenshot inspection, or desktop/mobile browser verification was performed. The offline harness does not have the target Next app runtime installed. These are remaining Track A release checks, not claims of deployed readiness. Minimal owner steps: apply to the pinned base (or consciously rebase/revalidate), apply the separate migration before deploying the routes, verify existing server settings, run the normal application checks, and smoke-test an owned running/delivered job plus an unauthorized job in the browser. No missing service implementation or provider integration remains for this bounded Trace Audit progress path.
