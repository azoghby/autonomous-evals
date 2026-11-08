# Independent SDK 0.12.3 contract review

Reviewed local installed `@usenaive-sdk/managed-agents` package version 0.12.3,
`dist/index.js`, `dist/index.d.ts`, and package README. The installed source was
available in sibling checkout `t3-6dfdf18b/tests/track-b/node_modules` during this
review; no provider requests, credentials, dependency changes, or live tests were
used. ECC was disabled. These observations describe this SDK contract, not a
live server attestation.

## Actual resources and parsed response shapes

`agents.list({ limit, after })` uses GET `/v1/agents`, and parses full AgentSchema
records, not a name-only summary. Every page requires `data`, `has_more`, and
`next_cursor` (string or null). Both continuation fields must be respected;
truncated, contradictory, repeated-cursor, or bounded-out scans cannot establish
name uniqueness or absence. Do not create agents after such a scan.

`agents.get(id)` uses GET `/v1/agents/{id}` and parses AgentSchema. Its identity
fields are `id`, `object: agent`, `name`, `harness`, and `current_version`, with
all configuration fields. `agents.create(body)` POSTs `/v1/agents` and parses the
same AgentSchema. A successful creation response is evidence about that returned
configuration, distinct from independent inspection of a preexisting immutable
version. A lost or unparsable create acknowledgement can leave a created agent;
never automatically repeat creation after that ambiguity.

`agents.getVersion(id, version)` uses GET
`/v1/agents/{id}/versions/{version}` and parses AgentVersionSchema. It contains
`version`, `created_at`, `created_by`, and configuration. It does **not** contain
agent ID, name, or harness. The authenticated requested ID plus a separately
inspected identity must bind the role; do not fabricate `version.id` or
`version.name` fields in test fixtures. Validate returned version equals the exact
requested positive safe integer. `listVersions(id)` exposes pagination but has no
query parameter in this SDK, so it is inappropriate for exact-version lookup.

Configuration includes `model`, `window`, `system`, `tools`, `mcp_servers`,
`skills`, `multiagent`, `budget`, `output_schema`, `structured_output_required`,
`description`, and `metadata`. `handoffs` is optional for older versions;
`model_selection` is optional nullable; notifications are also optional. Tools
have `default_config.permission` and `configs` keyed overrides. Each override's
`enabled` defaults to true, so deny-by-default alone cannot establish deny-all.
Require empty overrides or validate every override is denied. Model selection
can override the nominal model; an active policy must not pass exact-model
verification. Role metadata must explicitly bind `ae_role` and `ae_managed`.

Missing handoffs is not explicit false. A fail-closed implementation should
report missing required attestation as operator-needed, rather than infer a
safe value or claim version verification. The SDK schema requires many other
configuration fields, so missing/redacted response fields become SDK parse
errors before application inspection. Such errors must be normalized without
printing their raw issues, response body, system text, or provider error message.

## Recommended regression cases

- Use `createClient` with injected fetch and complete exact schema fixtures for
  AgentSchema and AgentVersionSchema. Assert actual GET version URLs and no
  PATCH/DELETE. Keep fixture API keys fake and never fall back to global fetch.
- Reject changed role metadata, name/ID binding, model, active model selection,
  instructions, period/task caps/period, default permission, allowed/ask override,
  nonempty MCP/skills, enabled multiagent, and handoffs. Cover missing handoffs
  and unreadable required configuration as operator-needed.
- Reject wrong returned exact version and invalid/unsafe version integers. Pin
  the inspected number; never use a later current version as the validated one.
- Reject duplicate same-name agents even with identical configuration. Repeated
  ID across pages must not silently overwrite a conflicting record. A same-name
  CEO/unmanaged agent cannot be adopted or edited.
- Cover has_more true/null cursor, false/non-null cursor, repeated cursor, and
  the final bounded page still having continuation. No create is safe when
  inventory completeness is unknown.
- Dry-run must inspect existing records but never create missing roles. Existing
  directory migration must verify the explicitly configured ID/version, rather
  than silently replace it with the currently named record.
- Creation acknowledgement checks must be labeled separately from inspected
  immutable-version checks. Failed acknowledgement/inspection must withhold
  the directory and avoid automatic create replay.
- Hostile API errors should yield stable typed diagnostics without raw error
  text, secrets, provider bodies, or configuration values.

No gap in basic model/tools/budget/system/MCP/skills/multiagent configuration
inspection requires a fabricated provider API: exact-version configuration is
available locally in the actual SDK contract. Name/harness and explicit optional
fields are the relevant distinctions to preserve.

## Implementation review

Reviewed the initial implementation and injected-fetch regression file after they
were written. The implementation uses the actual `get`/`getVersion` resources,
keeps optional configured pins exact, validates the enumerated role restrictions,
finishes discovery and all existing-agent validation before creating anything,
and normalizes provider failures without raw causes. No mutation path edits or
deletes existing agents. Creation responses and subsequent exact-version reads
are independently checked; returned creation IDs remain reconciliation data.

Initial test fixture corrections reported to the implementation owner:

- Harness must be `pi`, `claude_code`, `vetta`, or `hermes`; `default` is invalid
  and makes every list fixture fail SDK parsing.
- Window must be `immediate`, `priority`, or `loose`; use `priority` to exercise a
  semantically changed valid configuration, rather than invalid `batch`.
- Add a schema-valid active selection policy, for example
  `{ options: { 'model-a': 'cheap', 'model-b': 'complex' }, min_confidence: 0.8 }`.
- Exact-version fixture should omit AgentSchema-only ID/name/harness/current
  version fields; SDK strips them, but including them obscures contract fidelity.
- Shared `AgentDirectory.agentVersion` is optional; local options validation must
  accept the type and reject missing pins at runtime with a typed diagnostic.

Further useful regressions are a complete 20th final page (no false truncation),
custom-model success as well as mismatch, a failed exact-version read immediately
after creation retaining its returned identity, and non-2xx/network hostile error
normalization. These do not require live provider access. Inventory scans are
bounded, but cannot guarantee snapshot isolation against a concurrent operator
creating a same-name record after discovery; deployment must serialize operator
provisioning. This is an operational limit, not proof of globally unique names.

Implementation owner integration: the fixture/type/policy findings above were
corrected. Exact version fixtures now omit identity-only fields; custom-model
success, complete twentieth-page acceptance, and failed post-create inspection
with identity retention were added. Final offline harness result: strict types
and 167 agent tests passed, including 45 provisioning tests. This result is
recorded by the implementation owner; the independent review used local source
and contract inspection and did not execute live calls.
