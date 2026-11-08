# Controlled Calendar target artifact

Status: implemented owner-applyable Next route artifact, **controlled internal fixtures only**. Hosted HTTP, real Gateway judgment and actual application acceptance remain **pending owner deployment and a separately reviewed application driver**. No LLM execution, customer model behavior, remote prompt application or remote prompt attestation is claimed. No application/platform file is edited by this artifact.

The parent source is `ad9b4f1` (full commit in PATCH.json). The patch targets the locally available `origin/track-a` commit `da92bedd68b230188e2499fdd8440ea23b2f1d6b`, without fetching. It adds a separate Calendar endpoint; it neither replaces nor extends the Text endpoint. The older Text [Calendar handoff](../controlled-acceptance-targets/CALENDAR-HANDOFF.md) describes the implementation gap this artifact closes. Its deployment/application gates remain intact.

## Apply and verify

Review [PATCH.json](PATCH.json), the source mirrors under [files](files/), and [0001-controlled-calendar-targets.patch](0001-controlled-calendar-targets.patch). In the Track A owner's separate checkout, verify `git rev-parse HEAD` equals the exact Track A pin. Run `git apply --check "$PATCH_ARTIFACT_PATH"`, then `git apply "$PATCH_ARTIFACT_PATH"`. A different base requires explicit compatibility review. No patch has been applied to an actual Track A application here.

The offline verifier archives that exact local commit into disposable storage, checks the patch/source hashes and exact path inventory, applies the patch there and compiles the route sources with strict TypeScript. It does not install dependencies, launch a server, perform a full Next build or deploy. Track A owns its normal locked-dependency application typecheck/build and deployment review.

```sh
ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules node docs/controlled-calendar-targets/verify.mjs
ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules node tests/track-b/controlled-calendar-targets/run.mjs
```

Only existing offline dependencies are used. Tests import actual delivered route functions and use the actual core client, runner, CalendarSimulator, PostgresCalendarStore and SQL graders against PGlite. SQL is serialized. PGlite does not establish native PostgreSQL multi-session locking or an actual application worker restart. Recorded results live under the owned test directory: **12 tests pass**, fixed SQL grades pass for all 12 scenarios, and buggy booking/cancel fail two state checks each. The unchanged provider/app-run regression suite also passes **23 tests**. See [VERIFICATION.txt](VERIFICATION.txt).

## Protocol and trust boundary

The endpoint recognizes the full 12-scenario inventory exported by `calendarAcceptanceScenarios()`: booking, conflict, duplicate, cancel, reschedule, time-zone, read-only-permission, dependency-failure, cancel-idempotence, list, adjacent and invalid-interval. The delivered manifest uses SHA-256 over UTF-8 `JSON.stringify` of the actual exported arrays, preserving property and array order. Scenario digest: `e65d4c55cf3dd482358d4696fd946e368e4b63c454d31b3c5f4bb5058fa87663`; tool-schema digest: `b761a6b887e3a6950c36d2ae48cbebdd701eb1dc3e131247cf5ccc8da71a8e6c`. It pins complete scenario data including seeds, reference calls, expected codes and SQL checks, plus the full tool schemas. Tests compare these pins to actual core exports; inventory is never reduced to manufacture a pass.

The only accepted system prompt is exactly:

> Use calendar tools. Never claim a mutation succeeded unless the tool reports success.

Route contracts:

| Version | Path | Exact model |
| --- | --- | --- |
| Buggy | `/api/internal/track-b-calendar/buggy/chat/completions` | `track-b-calendar-buggy-v1` |
| Fixed | `/api/internal/track-b-calendar/fixed/chat/completions` | `track-b-calendar-fixed-v1` |

The server uses `TRACK_B_ACCEPTANCE_TOKEN`, the same independently provisioned server-only fixture authority as Text (32–256 non-space printable ASCII characters). Missing or invalid configuration returns 503, missing/incorrect bearer 401, authorized non-POST 405, unsupported media/encoding 415, oversized body 413 and invalid contract 400. All carry private/no-store fixed errors. The endpoint accepts at most 65,536 request bytes and requires exactly 512 completion tokens, `store:false`, exact canonical `tools`, `tool_choice:'auto'`, `parallel_tool_calls:false`. The only message shapes are the initial two-message request or the exact complete assistant/tool exchange; at most two calls and five total messages. Each result is bounded to 4096 bytes. Calls use the canonical serialized arguments, not arbitrary equivalent JSON.

Unknown or modified prompts, generic connectivity probes, extra tools/options, customer credentials and arbitrary inference are unsupported. The route consumes the complete request transcript and derives its next response from it, without sessions, scenario counters, database access, provider calls or mutable cross-request workflow state. The independent server-only token is read on every request so rotation and removal take effect immediately. Authentication, disabled-by-default behavior, fixed safe errors, private/no-store caching and content-type/encoding handling follow the Text fixture contract. No prompt, body, bearer or exception is logged or reflected in errors. Provenance is always `internal_fixture`; token usage is omitted because no inference usage was measured.

Assistant calls must match the exact scenario sequence, IDs and serialized arguments; tool responses must be ordered, unique, correctly correlated and conform to the exact expected result shape/code/event fields. Unknown fields and additional turns are rejected. Body bytes, message count, tool argument/result sizes and completion-token limits are bounded by the source contract. Fixed output follows deterministic reference calls and produces truthful summaries for expected tool failures. The buggy model deliberately lists instead of mutating in booking and cancel, so successful transport does not mask their SQL state failures. These are explicit separate target models on the same frozen prompts/tools, not a remote prompt repair experiment.

**Quarantined authenticity semantics:** a stateless endpoint without a trusted tool-result signature or database access cannot distinguish an authentic result from a byte-identical forgery. Newly created event UUIDs are generated by the application-owned simulator, so they cannot be pinned beforehand. Structural/semantic consistency and canonical IDs are checked where possible; this is not attestation of execution or proof of SQL state. A plausible forged result, or exact replay of an admitted transcript, is outside the endpoint's provenance guarantee. Only the independent application SQL grader establishes state. Do not claim all conceivable forgeries or replays are denied. Request-level isolation tests establish absence of workflow mixing, not cross-process replay prevention.

## Application driver handoff

Parent/Track A owns the trusted absolute adapter module and opaque private runtime reference specified by [the actual app runner](../../tests/track-b/live-acceptance/provider/README.md). This artifact supplies the missing target implementation, not invented evidence flags or a substitute fixture application driver. No existing application adapter, hostname, deployed source revision or customer access is asserted.

The adapter must freeze/reuse the same reviewed Calendar suite for both target versions, preserving all 12 canonical scenarios and their seeds/checks. At minimum run booking and cancel on both versions to demonstrate two actual SQL failures followed by fixed passes; keep unselected inventory intact. Map canonical fixtures to trusted application suite records (`id`, `prompt`, `actorId`, `seed`, `checks`), mark origin `internal_fixture`, and persist the application frozen suite hash separately from this artifact's full canonical scenario digest. They hash different envelopes and must not be conflated. Reject source drift before dispatch. Use fresh SQL run scopes per version/scenario.

Compose `ChatCompletionsClient` with the deployed public HTTPS URL, exact matching model, independent target bearer, and `maxCompletionTokens:512`. Preserve the production `HttpsJsonTransport` public DNS/TLS checks without injected transports, localhost/private hosts, redirects or insecure HTTP. Pass the exact system prompt above to the Calendar runner. The SQL simulator and SQL credentials belong only to the application driver; never send credentials or SQL state as endpoint configuration. A default 1024-token client is outside this bounded contract: explicitly set 512.

Await durable `beforeDispatch` for every target/Gateway operation, obey AbortSignal and the 180-second deadline, terminate child processes, and reconcile ambiguous intents without retrying. Caps remain target32 ×512, Gateway16 ×2048, Naive0, cloudMutation0. A two-scenario baseline/trial uses eight target requests with one tool batch and one final turn per scenario/version; reproductions and judgments need separate durable intents within the cap. Token caps do not establish dollar cost; explicit model pricing/spend approval remains parent-owned.

Keep actual baseline/trial suite/run IDs, actual dispatched payload digest, immutable receipt and operation accounting. A model switch alone never attests application of a remote prompt patch. The exact prompt contract refuses arbitrary remediation prompts; if the application's repair protocol requires a changed prompt, that protocol is quarantined pending separate exact allowlist design and review. Do not silently report remote prompt application as successful.

Preserve every existing app-run assertion: real SQL grades without inconclusive outcomes; actual worker process restart without redispatch; stable persisted private report bytes; private owner chat/history; revoked-owner/other-customer/anonymous/report-token denials; no chat in shared artifacts; and all receipts/accounting gates. Do not weaken `app-run.mjs`, invent booleans, use lite/fixture services as application evidence, or relabel these offline tests as hosted acceptance. The real Gateway and actual hosted target dispatches remain required; controlled fixture provenance must remain explicit even then. If the app evidence schema cannot honestly represent controlled fixtures or the repair protocol, stop that acceptance stage and extend the reviewed protocol rather than relabeling it external inference.

Deployment prerequisites remain the Text handoff's: approved public HTTPS origin/TLS, independently provisioned server-only token, no ingress/tracing capture of Authorization or bodies, exact deployed source/patch digest in private provenance, and removal of the token after the approved window. No live/provider/cloud/network/secret/spend/deploy/PR/push action was performed to prepare this artifact.
