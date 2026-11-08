# Offline roster rollout and application handoff

Implemented in actual `scripts/naive-roster.ts`, `naive-roster-config.ts` and `naive-roster-handoff.ts`. The compiler removes manual stage-option assembly and receipt merging. It reuses the existing five-stage planner and receipt validator; it does not provision resources, read provider keys or role bearer files, activate deployments, or implement internal MCP/idle routes.

## Private rollout specification

Prepare one private JSON file, owned by the current user with mode 0600. Obtain needed secrets through the private secret form, never chat or committed examples. The compiler accepts these exact fields and rejects extra fields:

| Field | Required value |
|---|---|
| `schemaVersion` | `naive_roster_rollout.v1` |
| `createRevisionAgents` | `true`; create revision names, never mutate existing agents or the org CEO |
| `revision` | Lowercase letter followed by up to 19 lowercase letters, digits or hyphens |
| `model` | Explicit provider model identifier; no inferred model |
| `appOrigin` | Exact HTTPS origin, without path, query, fragment or embedded credentials |
| `internalMcpUrl` | That origin plus `/api/mcp/internal/mcp` |
| `onIdleUrl` | That origin plus `/api/naive/idle/` and a privately supplied opaque URL-safe path token |
| `credentialFiles` | Exactly seven role keys: `planner`, `prospector`, `outreach`, `onboarding`, `owner_liaison`, `leaderboard`, `copilot`; each value a distinct absolute private bearer-file path |
| `schedules` | Exactly five role keys: `planner`, `market_researcher`, `prospector`, `outreach`, `leaderboard` |

Each schedule requires `cron` (five numeric cron fields; lists/ranges/steps supported), `timezone` (valid IANA zone), and `inputTemplate` (explicit nonempty task input). Optional `budgetMicroUsd` must be positive and no greater than that role's existing task cap. Omitting it preserves the manifest task cap. Schedules, model, callback token and task inputs are never invented. Named months/days, cron macros and provider-specific cron extensions are not supported by this compiler.

The fixed URL paths are **proposed owner integration contracts**, not deployed endpoints. Knowing a URL, supplying a token, or creating a vault credential does not establish working authorization. Callback authenticity and entropy must be established by the application owner; syntax validation does not establish either. File paths are not read or proof of distinct credential values.

## Commands

Create the first private directory containing the exact existing provisioner inputs:

```sh
npx --no-install tsx scripts/naive-roster.ts --next /absolute/private/rollout.json /absolute/private/resources-stage
```

This writes mode 0600 `options.json` and `plan.json` inside a newly created mode 0700 directory. It prints only the stage, operation count and `applyReady:false`. All configuration and receipt validation completes before any output directory is created. Existing directories/files and dotenv output names are refused.

Use those files with the existing provisioner when separately authorized and credentials are available:

```sh
npx --no-install tsx scripts/naive-provision.ts --check /absolute/private/resources-stage/plan.json /absolute/private/journal --receipts /absolute/private/resources-stage/options.json /absolute/private/resources-receipt.json
```

The existing provisioner's `--check` is provider read-only; `--apply` creates missing resources. **Those are online operations**, distinct from the new offline compiler. An incomplete check cannot produce a complete receipt. Retain provider receipts and journal fences; do not synthesize attestation or erase uncertain creates.

Compile the next stage by supplying every completed receipt in order:

```sh
npx --no-install tsx scripts/naive-roster.ts --next /absolute/private/rollout.json /absolute/private/agents-stage /absolute/private/resources-receipt.json
```

Continue `resources → agents → coordinator → credentials → deployments`, adding one receipt file after each successful stage. The compiler determines the next stage; there is no stage-skipping option. At most four prior receipts are accepted by `--next`. Every completed stage is rebuilt from the specification and validated prior receipts, and the canonical export must match the supplied bundle exactly.

After all five stages, produce the private application handoff:

```sh
npx --no-install tsx scripts/naive-roster.ts --handoff /absolute/private/rollout.json /absolute/private/application-handoff.json /absolute/private/resources-receipt.json /absolute/private/agents-receipt.json /absolute/private/coordinator-receipt.json /absolute/private/credentials-receipt.json /absolute/private/deployments-receipt.json
```

The handoff includes all 15 role `NAIVE_AGENT_*` assignments from the manifest, exact role→MCP permissions, coordinator member pins and five verified retained deployment identities. Deployment identities are role-indexed; no invented environment-variable readers are claimed. Callback URL and input templates are represented by fingerprints; bearer paths, bearer values and the callback token are omitted. No `.env` file is written. Applying these pins to an app that does not read them does not activate those roles.

## Evidence and recovery

Receipt bundles remain trusted retained metadata, not cryptographic provider attestations or fresh authority. Changing an already-attested stage's relevant configuration fails validation. Future-only choices can still change before their affected stage is completed: resource receipts do not freeze a future model or deployment schedule. `rolloutFingerprint` identifies the specification used for the current output; it is not a signed commitment embedded in existing receipts. A complete five-stage handoff checks all relevant stage configuration together.

Inputs must be regular, nonsymlink, private owned files, at most 2 MB; FIFO opens are nonblocking and rejected. Referenced bearer paths are never opened. Outputs are exclusive and fsynced. The two-file stage write is not an atomic filesystem transaction: a crash can leave a partial private directory. Retain it for inspection and use a fresh directory on retry; the command does not delete evidence or overwrite another run.

Focused tests cover five-stage compilation, unchanged planner output, ordered and exact receipt validation, stale/swapped/duplicate identities, terminal pins, no private callback/path leakage, private CLI modes, rejected symlinks/FIFOs/oversized inputs, no overwrite, no dotenv writes and offline subprocess output. See LEDGER for final repository checks. No SDK/resource creation or live call was used for this implementation.

## Remaining owner and acceptance work

Internal MCP, role bearer-hash registration/rotation, short-lived scoped task tokens, current authority checks and audited exact tool handlers are absent from actual app source. The new [internal MCP candidate](naive-internal-mcp-integration/README.md) implements owner task issuance and the audited progress-read path in staged source only; it does not activate the roster or copilot. The first complete read-tool slice should connect the copilot's `get_progress_snapshot` to an authenticated task/session issuer and the current owner-only safe projection; a signing helper alone is insufficient. Customer MCP credentials must not authenticate this internal surface.

The idle endpoint must authenticate wakeups, fetch authoritative session state, validate output, persist idempotently and account costs; callback bodies are not cost or tool-approval authority. Pause/resume, founder approval and budget controls need current hosted acceptance before deployment activation. Five paused deployment receipts do not prove any of these handlers work.

Full Naïve Phase0 conformance, roster acceptance, remaining method composition and later phases remain open. Historical company/Scout patches and current factual/sourcing candidates are not adopted internal MCP or idle implementations.
