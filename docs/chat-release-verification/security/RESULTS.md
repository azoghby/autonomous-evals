# Independent authenticated route and SQL acceptance

Recorded 2026-11-07. Seven tests passed, none skipped, in `results.txt`.

The harness executes the actual patched `GET`/`POST` route, request dispatcher,
structured reader, core chat service, credential decryption, conversation store
and SQL against PGlite. Only the session identity and Neon transport are replaced.
The pool replacement delegates every query, including ownership predicates and
conversation transactions, to a real local PostgreSQL engine. It does not return
fabricated authorization/conversation rows.

Exact application source: Track A `2dff9d8af8cccdd171d78760a0d74136d138fcb4`.
Exact core source overlay: `de6a7985e72b57fce79ef7f69f533b0b2da126a7`.
Application order: prior combined patch, immutable core overlay, structured patch.

SHA-256:

- Prior combined patch: `df804eac5b27f299f4b742dd5ada18f72ed6d3fba79c7790b9c25ae97d067773`.
- Structured patch: `f789fdda53766b7f08fded92b28452f9472a7a09abd03fcd82f87150eee42995`.

Reproduction:

```sh
node docs/structured-progress-integration/verification/validate.mjs --stage-only
node tests/track-b/chat-release/security/run.mjs PATCHED_STAGE /tmp/track-b-harness/node_modules
```

The first command archives the exact pins into a disposable directory without a
Git worktree. `PATCHED_STAGE` is its printed staging path. The second command
uses already installed Vitest/Zod/PGlite dependencies. Tests create synthetic
local tables plus the actual conversation, structured-inventory, checkpoint and
acquisition migrations in PGlite. No service migration is run.

Passing checks cover:

- Running and delivered routes, immutable replay with a stable message ID,
  conflict on changed input, ordered keyset history and read-only polling with
  unchanged cursors. Poll/history do not append exchanges.
- Real SQL ownership denial across jobs/users, no session denial even with a
  public-share query, and operator authorization with separate private history.
  This checks the private route boundary; it does not drive the public-share UI.
- Newly configured current encrypted credentials screen old persisted replies,
  history and replay; failures return safe text and do not append.
- Same-origin enforcement, caller identity injection, bounded body size and
  invalid pagination fail without writes.
- Missing structured inventory fails closed. Trusted missing/blocked checkpoints
  produce bounded uncertainty without raw checkpoint reason text.
- Saved confirmed Text and Calendar findings survive the complete authenticated
  route and immutable replay, while raw response/evidence/prose stays private.

No genuine source defect was found in these cases, so no correction patch was
created. These are local request-dispatch and SQL tests. They do not establish
real session cookies, remote Neon transport, native PostgreSQL multi-session
locking, Workflow production of inventory, authenticated HTTP deployment,
browser rendering, or public-share page behavior. The synthetic app tables
exercise selected actual SQL; they do not replace the owner's full schema and
migration compatibility check. No cloud, provider, spend, outreach or secret
retrieval occurred.
