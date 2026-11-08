# Phase 0 provisioning receipt handoff

Implemented in actual `scripts/naive-provision.ts` and `scripts/naive-provision-receipts.ts`. This removes manual reconstruction of dependency metadata between the five roster stages. It does not create resources automatically, activate deployments, implement the internal MCP/idle routes, supply consent or certify live Phase 0 acceptance.

## Commands

Generate a stage plan from a private options file as before:

```sh
npx --no-install tsx scripts/naive-provision.ts --roster-plan /absolute/private/resources-options.json /absolute/private/resources-plan.json
```

The existing `--check PLAN JOURNAL` and `--apply PLAN JOURNAL` remain valid. The optional receipt export requires the exact options used to generate that plan:

```sh
npx --no-install tsx scripts/naive-provision.ts --check /absolute/private/resources-plan.json /absolute/private/journal --receipts /absolute/private/resources-options.json /absolute/private/resources-observed.json
npx --no-install tsx scripts/naive-provision.ts --apply /absolute/private/resources-plan.json /absolute/private/journal --receipts /absolute/private/resources-options.json /absolute/private/resources-created.json
```

These commands require the privately supplied provider credential (`NAIVE_API_KEY_FILE` or `NAIVE_API_KEY`). No credential value belongs in command output or checked-in options. `--check` is read-only at the provider; explicit receipt export writes one local private file. If any resource is missing, `--check` cannot export a complete receipt bundle. The CLI reports a generic failure and does not write a receipt export.

Each bundle contains `schemaVersion`, `evidence`, `stage`, `planFingerprint`, enriched `receipts`, and the current stage's `resources` (kind/name/status/id/version). The terminal deployment stage retains all deployment IDs even though no later stage consumes them. No operation bodies, credential values, credential file paths, input templates or callback URLs are exported.

For the next stage, place the bundle's `receipts` object in the next options file's `receipts` field. This is a mechanical JSON merge, not reconstruction of IDs, fingerprints or role bindings. For example, in a private shell with a restrictive umask:

```sh
umask 077
jq --slurpfile prior /absolute/private/resources-created.json '.receipts = $prior[0].receipts' /absolute/private/agents-base-options.json > /absolute/private/agents-options.json
```

Use the sequence `resources → agents → coordinator → credentials → deployments`. Retain each private stage bundle. Agent names require the explicit revision opt-in; the existing org CEO and legacy agents are never updated. Deployments remain disabled/paused.

## Validation and replay

Before credential reads or SDK construction, export mode regenerates the exact plan from the supplied options, compares its fingerprint, and validates retained receipt schemas, role bindings and configuration fingerprints. The compiler then requires a complete, ordered, name/kind-matched set of successful attested results. Missing, malformed, duplicate, stale, conflicting or secret-bearing fields reject. It validates ID uniqueness across the merged prior/current receipts, not just within one stage.

The file writer uses exclusive creation, no-follow, mode0600 and fsync; it never overwrites a previous receipt. It is not a rename-based atomic replacement. A crash may leave a partial file that requires local reconciliation; strict JSON/receipt validation must reject it. Use a fresh export path on replay. If resources were created but writing the export failed, rerun the same plan with `--check` and a fresh filename to discover/attest them; do not delete journal intents or assume creation is safe to repeat. Existing creation fences and receipt journals are unchanged.

Exported metadata is **retained evidence, not fresh provider authority**. Each later operation still uses the provisioning adapter's fresh provider attestation. A simulated five-stage test does not prove the provider has created or configured the roster.

## Evidence and remaining Phase 0 gates

Local tests cover five-stage progression, exact-plan binding, missing/reordered/duplicate results, invalid versions, changed options/configuration, secret-bearing metadata, cross-stage role-ID aliasing and terminal deployment export. Strict standalone CLI TypeScript and the original root verification are recorded in LEDGER.

Still required: authorized internal MCP/idle application routes, role-bound bearer credentials, concrete schedules/callbacks and models, exact provider attestation/creation receipts, isolated staging acceptance and full real conformance. No live provider call or provisioning action was performed to implement this handoff.
