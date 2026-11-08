# Controlled acceptance target handoff

Status: prepared internal deterministic fixture; **not deployed, no hosted HTTPS acceptance run**. No provider calls, credentials, secret files, cloud mutations, spend, outreach or push were used. Changes are confined to this artifact and `tests/track-b/controlled-acceptance-targets/`. ECC was not used.

This target serves canned answers to the exact accepted fictional Lumen Text suite. It is not a live LLM, general inference endpoint, customer intelligence validation, or remote prompt-patch attestation. Hosting it can exercise the production secure HTTPS transport and real Gateway judgment when separately authorized credentials are available. SQL engine paths require the separate application/Calendar driver below; the direct Text runner does not exercise SQL.

## Pinned patch and deployment prerequisites

Track A base inspected locally without fetch: `da92bedd68b230188e2499fdd8440ea23b2f1d6b` (`origin/track-a`). Apply [0001-controlled-acceptance-targets.patch](0001-controlled-acceptance-targets.patch) to that exact base in the Track A owner's checkout using `git apply --check` first, then `git apply`. Source mirrors are under [files](files/). The patch adds server route files only; no platform, environment manifest, package, app configuration or database changes. No migration is needed by this target.

The older [workflow integration series](../workflow-integration/README.md) pins a different Track A/core pair and is not automatically included or certified by this patch. This target is independent of that series. Track A owns reviewing any combined checkout, its normal Next build/typecheck and deployment. This artifact does not authorize deployment or certify that unrelated series apply to the current Track A pin.

Before an authorized hosted run, Track A must:

1. Review/apply the pinned patch, build/typecheck the application with its existing locked dependencies, and deploy through its approved process. No active hostname is assumed here.
2. Explicitly provision the server-only `TRACK_B_ACCEPTANCE_TOKEN` through private configuration. A valid token is 32–256 printable ASCII characters without spaces. This independent token must not be a customer, database or Gateway credential; never expose it as `NEXT_PUBLIC_*`. Missing or invalid configuration disables both routes with 503. Parent privately arranges the matching runner token reference; this handoff contains names only.
3. Supply the actual approved public HTTPS origin, valid TLS certificate, and exact deployed source revision/patch digest. Production `HttpsJsonTransport` public-DNS pinning and TLS checks must remain enabled; localhost, private addresses, insecure HTTP, redirects or mock transports are not substitutes.
4. Ensure deployment infrastructure does not capture request bodies, prompts, Authorization headers or raw response payloads in access logs, tracing, analytics or error reporting. Route source does not log these values. Use private access controls/ingress limits as appropriate; bearer authorization remains mandatory. Turn the endpoint off by removing its token after the authorized window.

Route contracts:

| Version | Path | Exact model |
| --- | --- | --- |
| Buggy | `/api/internal/track-b-acceptance/buggy/chat/completions` | `track-b-lumen-buggy-v1` |
| Fixed | `/api/internal/track-b-acceptance/fixed/chat/completions` | `track-b-lumen-fixed-v1` |

Both use the same independent bearer authority and reject the other model. Only POST with JSON, at most 16,384 body bytes, exact two frozen system/user messages, `store:false`, and integer `max_completion_tokens` from 16 through 512 is accepted. Only `model`, `messages`, `store`, and `max_completion_tokens` are allowed. Tools, streaming, extra messages/options, mutated system prompts and unknown user prompts are rejected. Requests are stateless and cannot mutate fixture state. Errors are fixed private/no-store responses and do not echo input. Responses are Chat Completions shaped with assistant text and `finish_reason:"stop"`; token usage is omitted because no inference usage was measured. Tool calls are deliberately unsupported and rejected, rather than pretending Calendar compatibility.

Accepted artifact: `packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json`, suite digest `0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9`. All S01–S12 are supported. Fixed replies use only authoritative fictional reference facts and the exact unknown-answer fallback. Buggy replies deliberately violate the forbidden-token objective. Neither version evaluates or changes a remote prompt patch. Generic `checkTarget()` / `Reply OK.` probes are rejected by design; use the exact bounded runner rather than adding a generic unauthenticated prompt exception.

## Runner configuration and evidence

[runner-config.example.json](runner-config.example.json) is a **template**, not active configuration. Replace the origin and filesystem placeholders with parent-approved values, select an explicitly approved Gateway model, and save the filled config outside the repository as a private regular file (0600, at most 16 KiB). Environment references contain names only. No credential value belongs in this file or evidence.

Parent owns the separate private `AI_GATEWAY_API_KEY` form and live execution. The existing runner and all assertions remain unchanged:

```sh
node tests/track-b/live-acceptance/provider/run.mjs --plan
# Only after parent approval of deployment, exact config/model/pricing and caps:
node tests/track-b/live-acceptance/provider/run.mjs --live --config /private/approved-controlled-text.json
```

The runner selects S01 and S09 from the unchanged all12 artifact: **4 target calls ×512 maximum completion tokens; 8 Gateway calls ×2048; 0 retries, 0 Naive sessions, 0 cloud mutations**. These are operation/token caps, not a dollar cap. No extra connectivity probes are authorized. Expected objective behavior: buggy has failures; fixed has none. A real Gateway must independently return pass for both fixed executions without rubric gaps; unknown, inconclusive and transport errors must remain failures to establish acceptance. Do not claim a guaranteed Gateway verdict from offline tests.

The route returns explicit fixture provenance. Core's Text adapter ignores extra completion metadata, and the existing runner uses legacy labels such as `actual_provider_text`. Those labels do **not** turn canned responses into LLM evidence. Retain a separate private run sidecar using [evidence-provenance.example.json](evidence-provenance.example.json), binding the runner runId/journal digest to the deployment source/patch digest and this fixture origin. Do not edit the journal to relabel or weaken assertions. Server-provided metadata is self-description, not independent deployment or remote prompt attestation. Endpoint logs and prompts/auth/raw payloads must never be copied into evidence.

Successful hosted Text acceptance proves real secure transport and real Gateway grading of a deterministic fixture. It does not prove Calendar, SQL persistence, restart, reports, private chat, customer inference or generic repair. SQL/Calendar handoff is exact and separate in [CALENDAR-HANDOFF.md](CALENDAR-HANDOFF.md).

## Offline verification

```sh
ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules node --test tests/track-b/controlled-acceptance-targets/route.test.mjs
```

This imports/transpiles the actual delivered route functions and checks the accepted suite digest independently, all12 fixed factual answers/objective passes and buggy objective failures, real core Text adapter response parsing, auth/rotation/disable behavior, strict version and payload separation, malformed/oversize/unknown requests, private errors, and concurrent/repeated request isolation. It uses synthetic test authorization only; no server, provider, cloud or customer data. See the owned test directory for recorded results. Strict route source TypeScript compilation and patch application to an archive of the exact Track A pin are also checked. This is not a full deployed Next build or hosted transport evidence.

Track A application commands (owner's separate checkout only; this task has not applied them):

```sh
# Verify HEAD is da92bedd68b230188e2499fdd8440ea23b2f1d6b before applying.
git rev-parse HEAD
# PATCH_ARTIFACT_PATH is the owner's absolute path to the reviewed patch.
git apply --check "$PATCH_ARTIFACT_PATH"
git apply "$PATCH_ARTIFACT_PATH"
```

Compare patch/source SHA-256 values against [PATCH.json](PATCH.json). If the base differs, stop and review/rebase the artifact; do not silently assume compatibility. Keep the patch digest and actual deployed revision in the private provenance sidecar.

The unchanged provider runner regression tests were also run offline: **20 passed, 0 skipped/todo** (`ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules node --test tests/track-b/live-acceptance/provider/*.test.mjs`). The controlled target suite records **15 passed, 0 skipped/todo**. No accepted scenario, objective/rubric assertion or runner gate was removed.

Reproduce the artifact/apply/type checks with `ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules node docs/controlled-acceptance-targets/verify.mjs` (point the variable to an existing approved dependency directory; no install occurs). [VERIFICATION.txt](VERIFICATION.txt) records the completed offline checks.
