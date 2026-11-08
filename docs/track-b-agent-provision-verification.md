# Track B agent provisioning verification

Implemented only operator provisioning, its offline regression tests, and these
handoff documents. ECC disabled. Independent child SDK review:
[sdk-contract-review.md](track-b-agent-provision-verification/sdk-contract-review.md).
No real provider calls, secrets access, spending, outreach, push, or PR.

## Contract and safety behavior

Verified local published `@usenaive-sdk/managed-agents` **0.12.3** package types,
resource implementation, and response schemas. No undocumented endpoint or
provider attestation hook was added. `list` returns full agent objects;
`get(id)` authenticates current name/ID, while `getVersion(id, version)` returns
immutable configuration, version and provenance but no name/ID/harness. The
requested authenticated resource path binds that version to the inspected agent.
This is API configuration evidence, not a proof about a deployed model's behavior.

`ensureAgents` scans at most 20 pages of at most 100 records each. It requires
consistent `has_more`/`next_cursor`, no repeated cursor or record ID, and a complete
scan. Duplicate role names block even if one matches a supplied directory. It
never selects a winner or creates a replacement after an incomplete scan. All
existing roles are inspected before any missing role is created. CEO and
unrelated records are inventoried only, never adopted, changed or deleted.

Exact versions must have role name/ID binding, explicit `ae_role`/`ae_managed`,
expected model, no dynamic model selection, exact role system and description,
immediate window, deny-by-default tools with empty overrides, no MCP or skills,
explicit false multiagent and handoffs, and exact role month/task caps. Even deny
overrides are rejected to require the canonical restricted configuration.
Missing optional handoffs is unavailable attestation, not assumed false. SDK
0.12.3 explicitly documents absent model_selection as no policy, so absent/null
is accepted; an active policy is refused. Missing required schema fields fail SDK
parsing and become sanitized inspection errors. Session output schemas remain
owned by the task/session layer; agent-level output settings are not attested as
part of this provisioning policy. Harness is not an option or a verified claim.

New agents use the canonical create body (including explicit null model selection).
The returned configuration is checked separately from a subsequent exact-version
GET. Only then can its pin enter the returned directory. Creation acknowledgements
are not described as verification of a preexisting agent.

Failures throw exported `AgentProvisioningError` with `operatorNeeded: true`, a
stable typed diagnostic (code/phase/role/field paths), and any acknowledged created
IDs/versions in `created`. No usable directory is returned after any failure.
Raw provider errors/configuration/URLs and error causes are withheld. A failed POST
or post-create read is `creation_uncertain`; an explicitly unsafe acknowledgement
is a creation-phase mismatch. Either can leave cloud state: reconcile inventory
before retrying. There is no automatic creation retry, update, delete, rollback,
or compensating mutation. Earlier successful creates are also retained for
reconciliation if a later role fails.

## Migration and compatibility

The successful return shape stays `{directory, created, missing}`. Existing
callers now receive a typed exception instead of trusting arbitrary same-name
records. `dryRun: true` still performs authenticated GET inspection, reports missing
roles, and never POSTs. It can now fail on unsafe existing configurations.

For an already configured deployment, pass its saved pins explicitly:

```ts
const result = await ensureAgents(client, {
  dryRun: true,
  model: deployedModel,
  directory: configuredDirectory,
});
```

Every supplied entry must contain an exact positive safe integer `agentVersion`;
the shared directory type allows omission elsewhere, but provisioning rejects it.
An ID not matching the single discovered role record blocks. Old exact versions
are inspected and retained even if the current version advanced; no silent pin
upgrade. Without `directory`, the discovered current version number is captured
and that exact version is read/pinned, even if current later changes. The current
agent's configuration is not substituted for the pinned version's configuration.

Existing mismatched or legacy unmarked records require an operator decision;
this code never repairs them automatically. Coordinate any manual version
replacement or naming/metadata migration, re-run verification, save the complete
verified directory, and explicitly update deployment configuration. A saved
runtime directory alone does not invoke this verifier: deployment must call it.
Do not use `error.created` as an approved runtime directory.

## Offline validation and remaining deployment checks

Run `node tests/track-b/run-checks.mjs --components agents --track-a-ref origin/track-a`
with the existing locked dependencies available. The harness stages sources and
local Track A contracts, strictly type-checks, and runs all agent tests. Fixtures
use the actual SDK client with an injected fetch and `.invalid` base URL. Tests
cover restrictive config changes, optional missing evidence, exact pins, identity,
creation checks/ambiguity, sanitized failures, duplicates, pagination boundaries,
and dry run. The independent review's fixture/type/model-policy findings were
integrated before final validation. Validation totals are recorded below.

Deployment must still run authorized authenticated inspection against the target
organization, resolve any operator diagnostics, serialize provisioning invocations,
confirm provider cap semantics/current account policies, persist pins, and wire
verified configuration into the parent-owned runtime. SDK requests use the
caller's SDK transport deadlines; the page count bounds calls, not elapsed time.
The list API supplies no snapshot or uniqueness transaction: another operator can
change inventory during/after discovery. Serialize external provisioning and
reconcile uncertain outcomes; this implementation does not claim distributed
uniqueness or atomic multi-agent creation. No live/deployed acceptance was run.

Final offline validation: strict TypeScript passed; **167 tests in 8 agent test
files passed, none skipped**, including **45** new provisioning regressions.
Local Track A contract input resolved to
`7771433722cac9f20536bcc55a142f7ed7d9d8b1`, contract SHA-256
`dc7936cf343e023a9f0b3b2c0ee02b3886a1f230397f282ee4aaec84a9b27101`.
Existing installed locked dependencies were reused via a temporary node_modules
symlink, removed after validation; no dependency/manifest changes were made.
`git diff --check` also passed.
