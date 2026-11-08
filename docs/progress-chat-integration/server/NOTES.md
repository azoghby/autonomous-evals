Server artifacts target `96cb4adcea8c55ae4d8cc353deb059996245aa77` and require the parent `core-security.patch` current-secret service fix. `server.patch` adds only the app route and concrete app adapter; mirrored sources in `files/` support review.

Apply `001-private-conversations.sql` as its own transaction before enabling the route/UI. It is intentionally outside the combined application patch. No database operation has been deployed or executed against a remote database.

Composition uses the app's existing `DATABASE_URL` and schema, with a lazy three-connection Neon WebSocket pool; the core composition pool is private and cannot be reused without modifying its ownership. HMAC references use the existing 32-byte `CREDENTIALS_ENCRYPTION_KEY`, with purpose/user/job/type domain separation. All current environment credentials, decrypted `job_credentials`, and decrypted GitHub target credentials screen the safe projection and the core service's replay/history/poll responses on every request. Credential deletion means historical deleted credentials are no longer known; no archive of deleted plaintext is created.

Projection selects only status, event milestone enums/timestamps, original finding status/severity, and known cost rows. Original findings exclude remediation rerun rows, avoiding inflated original-evaluation counts. Cost completeness is always unknown: the app schema has no completeness marker. Status/time reflects persisted rows, not request time. No structured text/calendar checkpoint claims, raw traces/prose, ETA, completion percentage, or provider calls are introduced. History stores the core reply and input digest, never the raw question. Full pages conservatively set `hasMore`; an extra empty page establishes exhaustion.

Authorization is owner-or-operator using the existing app policy, while conversations partition by the authenticated viewer AND job. Session authentication precedes database access; material reads and authorization run in one pinned REPEATABLE READ READ ONLY transaction, and the core service rechecks current job access before reads/writes. Conversation append pins its own READ COMMITTED transaction per the core port contract. GET history/poll never append or invoke workflows; POST writes only the private chat tables. Same-origin Origin is required for POST. All failures use fixed responses and private/no-store cache headers.

Offline verification against an applied combined-patch staging:

```
node docs/progress-chat-integration/server/run.mjs /path/to/patched-stage /path/to/existing/node_modules
node docs/progress-chat-integration/server/typecheck.mjs /path/to/patched-stage /path/to/existing/node_modules
```

The existing dependency directory must contain vitest, TypeScript, zod, and Node types. No installation/network is performed. Tests execute actual patched core and app production sources; Neon and session are local fixtures. Targeted typecheck uses actual app route/adapter, patched core chat modules, redactor, and crypto. Neon SDK and session have explicit structural offline declarations, so this does not verify their installed SDK declarations or the full Next app build. Run the normal Track A workspace typecheck with installed workspace dependencies before merge. No local Next docs distribution was available to inspect; route follows the exact base's async `params` convention. Production Neon connections and full app rendering are not verified here.
