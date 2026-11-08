# Read-only Neon branch check

`node check.mjs --plan` performs no requests or secret reads.
`node check.mjs --read-only --config /private/config.json` reads two exact branch
metadata endpoints through the existing fixed-origin Neon transport. The private
0600 JSON config contains `projectId`, `mainBranchId`, `seedBranchId`, and `keyFile`.
No credentials belong in repository files. It never queries SQL, creates/deletes
branches, changes configuration, or claims that seed migrations exist.

Offline checks: `node --test tests/track-b/neon-readiness/check.test.mjs` (5 passed).
A 404 means absent **or not visible**, never proof of deletion. Scope/identity
mismatch and other failed reads reject the check. Provider error bodies are not
printed. Authentication failures must be resolved before diagnosing branch
configuration.

Parent live observation on 2026-11-07: the configured main and seed metadata GETs
both returned HTTP 401. This establishes failed authentication only. It does not
establish a missing seed, wrong project, SQL connectivity or deployed settings.
No mutation or database query occurred. The private key was neither printed nor
committed. A replacement credential must use the private secret form.

With a replacement private credential, the subsequent check succeeded: both
configured branches exist in the project; main is default and seed is nondefault.
Nonsecret evidence is in `verified-branches.json`. This supersedes the credential
block, not the unverified SQL schema or deployed configuration. It does not explain
the older application's snapshot/TTL error for an individual job branch.
