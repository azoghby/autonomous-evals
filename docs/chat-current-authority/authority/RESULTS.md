# Actual applied route and SQL authority review

Release blocked. At the supplied current integration candidate, six of nine strict local cases pass; three fail. The same three failures were first observed on the historical release composition. The review does not edit app/core code or the adoption team's artifacts.

Candidate parent: `039851736eabb94e85c2c111bbccc78374716275`. Reviewer checkout: `7f492e2cba2004eca4aeff13752a9380f602f2dc`. [CANDIDATE.json](CANDIDATE.json) retains the adoption team's complete manifest, including `chatClientMounted:false`. [candidate-pin.json](candidate-pin.json) records independently measured SHA-256 hashes; route and server hashes match the candidate manifest exactly. The candidate is a staged artifact, not a committed application adoption. Current reviewer checkout has neither applied chat route nor applied server helper.

## Reproduce

`node tests/track-b/chat-current-authority/authority/run.mjs APPLIED_STAGE [EXISTING_NODE_MODULES]`

Default dependencies are the existing `/tmp/track-b-harness/node_modules`; no install occurs. This imports actual staged route, request adapter, core service and SQL conversation port. Only session lookup and Neon Pool are replaced: session identity is scripted and the pool executes real SQL in local PGlite. Actual migration scripts create conversation, structured inventory, text checkpoint and acquisition tables. The runner forwards a whitelisted environment containing only synthetic database and encryption values; it does not load `.env`, contact a database/provider or use hosted authentication.

## Confirmed defects and minimum repro

The POST route creates `progressChatForRequest` **before consuming its streamed JSON body**. That helper captures `me`, `isOperator`, `material.snapshot` and `material.knownSecrets`. Core service later invokes `authenticate`, but the app's bound implementation returns captured identity. `resolveAuthorizedJob` uses the captured operator flag and `knownSecrets` remains the earlier array.

The harness waits for the real snapshot transaction COMMIT, changes one local authority value, then releases the delayed request body:

1. Set scripted current session to null: POST returns **200**, expected **401**, and can append a new exchange.
2. Remove current operator grant on another owner's job: POST returns **200**, expected **404**.
3. Insert freshly encrypted synthetic credential `running` after snapshot acquisition: POST returns **200**, expected **503**, and generated reply contains that current credential word. This is a deliberate collision demonstrating current-policy screening; no real secret is used or disclosed.

The third defect also affects replay policy if a current credential changes during that body boundary. Separate next-request checks correctly return 503 for saved history, stable retry and poll after credential rotation.

Strict failing assertions remain in [authority.test.ts](../../../tests/track-b/chat-current-authority/authority/authority.test.ts). See [candidate-final.log](candidate-final.log) and [candidate-results.json](candidate-results.json).

## Passing cases

- Actual send/history/poll deny other customers and anonymous/public-share callers; owner/operator conversation histories remain separate. Errors preserve `private, no-store` and `Vary: Cookie`.
- New requests deny changed ownership and revoked scripted sessions.
- Ownership changed after the initial snapshot is rechecked before send and denies without appending.
- Fresh next-request encrypted credentials rescreen old history, retry and poll.
- Actual projection HMAC evidence references differ by viewer and job; raw event/finding/cost IDs and prose are absent. Actual SQL poll excludes the raw event ID.
- Missing authoritative structured inventory fails closed; a valid plan with absent checkpoint yields bounded unknown/blocker; a newer app progress event than inventory watermark fails closed.

## Correction artifact and remaining boundary

[0001-refresh-authority-policy.patch](0001-refresh-authority-policy.patch) refreshes session identity/grant at service authorization and refreshes current credential screening after current job access resolution. It applies cleanly to the candidate. The patch was applied **only to a disposable candidate copy**, never the adoption team's candidate or app source. All nine unchanged strict cases pass there: [corrected-final.log](corrected-final.log), [corrected-results.json](corrected-results.json), [corrected-pin.json](corrected-pin.json). The patch adds SQL work and can return unavailable when policy refresh fails; review that behavior before owner adoption.

This fixes the exercised body/snapshot gap. It is not a claim that revocation and credential changes serialize atomically with every read/write/HTTP response. A revocation after the final authorization check or after database append still needs an agreed transaction/generation protocol and independent testing. PGlite here uses one connection and does not establish real Postgres locking/concurrency or Neon transport.

Full copied-app TypeScript was attempted with the candidate's existing compiler/dependencies and `--noEmit --incremental false`. It exits 2 on `layout.tsx`: missing `@vercel/analytics/next` and generated `LayoutProps` (the scratch copy deliberately excludes `.next`). There are no diagnostics in the patched helper, but this is **not** a passing full typecheck. See [corrected-app-typecheck.log](corrected-app-typecheck.log). Integration-level repository checks and commit belong to the parent; this child is instructed not to commit.

Hosted acceptance remains: actual cookie/session invalidation; real operator allowlist removal; independent signed-in customer/job/history/artifact/report denial; real credential and encryption-key rotation; multi-connection revocation/ownership races; authenticated running/delivered jobs and mounted client adoption. No browser, cloud, provider, production, push, migration outside the local fixture, or paid action ran.
