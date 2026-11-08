# Pinned LoopbackJsonTransport review

Reviewed tree: **72d523bf2f213163b3fd2a62f5a24cbf6c838e8d**. All source line numbers below refer to that tree, independently of parent HEAD changes. This reviews the implementation present in that tree; the commit's own diff is mostly demo work and does not introduce all the transport code.

Owned artifact: `tests/track-b/loopback-transport-review/review.cjs`. No production changes, staging, commits, fetches, installs, cache edits, or child agents. LEDGER was read but deliberately not edited under this assignment's stricter two-path ownership.

## Findings for parent

### P2: timeout is socket inactivity, not an absolute request deadline

`packages/core/src/targets/transport.ts:148-165`: passing `timeout` into `http.request` and handling its `timeout` event leaves a request alive as long as the local server keeps sending bytes. Unlike HttpsJsonTransport's AbortController deadline, elapsed time is not bounded. A local agent can stream progress or whitespace before completing its JSON and overrun the operator's configured target timeout. This is a local evaluation reliability/resource-lifetime defect, not a remotely reachable SSRF claim.

Reproduction: the disposable server in `CHARACTERIZATION: timeoutMs is inactivity only` sends a byte every 5 ms, completes after 180 ms, and succeeds with `timeoutMs: 60`. It always ends the response and closes sockets/timers; test budget is 3 seconds. The byte cap does not substitute for an elapsed-time cap. The public runner's outer Promise.race (`apps/web/src/server/public-agent-runner.ts:98-104`) rejects without cancelling the underlying target request, so it does not fix the transport lifetime.

Minimal parent fix: add an absolute timer covering request/response lifetime; on expiry reject with TargetError('timeout') and destroy the request/response. Clear the timer on every success/error/oversize/status/parse exit, including synchronous request construction failures. Preserve timeout classification when destroy causes a later error. A settled-once cleanup helper is sufficient; no changes to HTTPS policy are necessary. Parent regression should require rejection at the deadline while bytes continue, and verify stream destruction and timer cleanup. The current characterization must then be changed to that desired assertion.

### P2: no outgoing JSON byte limit

`packages/core/src/targets/transport.ts:144-156`: LoopbackJsonTransport has no `maxRequestBytes` option or payload-size check. The offline mock proves a JSON payload exceeding the HTTPS default 256,000-byte cap is handed to `req.end`; the identical input is refused before network access by HttpsJsonTransport. This makes the opt-in path unbounded in outgoing bytes even though responses are bounded. Large fixture inputs or conversation history containing large local replies can be transmitted in full. Allocation during JSON.stringify itself is also unbounded in the existing HTTPS implementation; this finding is specifically the missing outgoing-byte check, not a claim that a post-serialization check bounds serialization memory.

Minimal parent fix: introduce a finite, validated request byte limit and check Buffer.byteLength before constructing the request, using TargetError('request_too_large'). A documented larger local default may be appropriate for local agents; it should still be bounded and configurable downward for tests. Assert no request construction for one byte over the chosen cap and success at exactly the cap. No web caller/exfiltration scenario is established.

### P3: nonserializable top-level JSON values escape the error contract

`packages/core/src/targets/transport.ts:150-155`: JSON.stringify(undefined), functions, symbols, or an object whose toJSON returns undefined succeeds with an undefined result. Buffer.byteLength then throws native ERR_INVALID_ARG_TYPE inside the Promise executor. The promise rejects, but with a raw TypeError rather than a TargetError. Lite converts that into generic `target_error`, losing the useful input diagnosis. This is an edge case for direct JsonTransport users; the current chat client constructs ordinary objects, so it is not a demonstrated standard CLI failure.

Minimal parent fix: check `typeof payload === 'string'` immediately after stringify and return TargetError('invalid_request') otherwise. Existing circular and BigInt handling is already correct. Test these inputs before request construction. This is lower priority than deadline/bounds.

## Reachability and safe controls

- `lite/deps.ts:26-34`: defaultLiteDeps constructs HttpsJsonTransport with TARGET_TIMEOUT_MS and TARGET_MAX_RESPONSE_BYTES; allowLoopback remains undefined. Setting allowLoopback alone does not switch transports.
- `lite/run.ts:45-50, 114-116, 223-227`: endpoint bypass requires both explicit allowLoopback and isLoopbackEndpoint. Both checkTarget and runSuite are exercised with unset/false/true values using pinned run/deps source and offline chat/AI stubs. Other HTTP private addresses remain rejected with the flag enabled. Subsequent reruns use the same runOne validation; target resolution does not set the flag.
- `apps/web/src/server/services.ts:224-226`: customer app constructs createLiteServices with resolveTarget only; the real-engine fallback uses the same construction. `server/monitoring.ts:125` uses getEvalServices, so monitoring cron does not enable loopback.
- `apps/web/src/server/public-agent-runner.ts:72-87`: local agent kinds require opts.allowLocal, then receive the explicitly paired allowLoopback and LoopbackJsonTransport. Nonlocal kinds receive default createLiteServices. This file is physically under apps/web but also shared by the operator CLI; file location alone is not proof of web reachability.
- `scripts/public-agents.ts:30-43, 57-59`: parses --allow-local and passes cli.allowLocal into runPublicAgent. `server/public-agent-cron.ts:141-144` passes suite/agent/budget/timeout/log/key options without allowLocal or injected services. `/api/cron/public-agents` calls that helper. No request-derived opt-in was found in these actual constructions.
- Endpoint checks reject localhost names, other 127/8 addresses, IPv6 loopback, public/private remote hosts, HTTPS, userinfo, and nonempty query/fragment. The connection hostname is hardcoded to 127.0.0.1 with pooling disabled and no DNS/proxy resolution. WHATWG accepts alternate numeric spellings that normalize to 127.0.0.1; they still connect to exactly that address, so this is not a destination bypass. Explicit :80 normalizes to an empty port and is refused; not raised as a blocker.
- Redirect/non-2xx responses are destroyed and rejected without following Location. Successful JSON and UTF-8 content-length bytes are tested. Response bytes beyond the configured cap destroy the response and reject. Request errors, response errors, malformed JSON, and emitted timeout settle correctly. A native loopback test also confirms an idle timeout and a mid-response socket abort reject with timeout/transport_error respectively, then observes peer socket closure before cleanup. These checks are not a proof of all native socket event interleavings.

## Parity differences, not additional remote security findings

- Bearer validation is absent: empty credentials are omitted; spaces/overlong ASCII tokens reach request options. Real Node rejects CRLF with ERR_INVALID_CHAR before connecting (covered without creating a server). There is no demonstrated header-injection exploit. Reusing HTTPS credential validation would improve consistent error codes, but all credentials here are operator supplied.
- Content-Encoding is ignored: actual gzip bytes are bounded as received and fail with invalid_json, while plaintext labeled gzip is parsed. No decompression occurs, so there is no decompression bomb. The transport does not advertise gzip; returning unsupported_encoding consistently with HTTPS is a small optional improvement, not a proven normal-path failure. Do not add automatic decompression without a decoded-byte bound.
- Constructor options lack HTTPS-style bounded validation; invalid/NaN values can defeat response comparison or change timeout behavior. They are trusted programmatic options, and the production local construction supplies a finite constant, so this is not independently promoted to a vulnerability.
- No global TargetGate is used on the local transport. The reviewed lite scenario pool remains at concurrency two. No separately reachable unbounded remote caller was established.

## Checks and limits

Run from repository root:

```sh
node --test tests/track-b/loopback-transport-review/review.cjs
```

Result: **14 tests passed, 0 failed** (final run approximately 0.62 seconds). They load the full pinned source through read-only git show, transpile in memory using existing TypeScript under `/tmp/sandbox-generation-deps.cBCEai/node_modules`, and inject node:http/node:https mocks. Two tests use disposable 127.0.0.1 servers; the CRLF test uses actual Node construction and fails before connection. No external DNS/network, providers, secrets, databases, cloud services, or spend. To use the other supplied dependency directory set LOOPBACK_REVIEW_DEPS to `/tmp/workflow-bootstrap.JpxCTM/node_modules` (also verified with the earlier 13-test version).

**CHARACTERIZATION tests assert observed defects/differences, not acceptance criteria.** A green review run documents the pinned implementation; it does not approve those defects or validate a parent's fixes. A fix regression must assert the intended corrected behavior against the parent's changed source, while retaining the safe controls. Source pinning intentionally means these tests continue examining 72d523b even after a merge/fix.

Root npm test does not discover this `.cjs` artifact under its configured includes; use the explicit command. Full app typecheck/npm test/build were not run in this isolated review (no production edits or parent integration claim). No app/cron modules were executed: reachability conclusions above come from reading pinned constructions; run/deps validation behavior is dynamically exercised with injected stubs. Parent retains responsibility for integration checks and commits.

## Parent correction verification

The parent prepared a correction against the exact reviewed transport while the upstream merge was still refreshing cloud-backed files. It adds an absolute request deadline, a configurable 256,000-byte maximum outgoing payload, finite constructor bounds, safe invalid-input errors, and consistent credential/encoding refusal. The HTTPS transport and loopback opt-in policy are unchanged.

`regression.cjs` is a separate acceptance suite; `review.cjs` continues to characterize the immutable original revision. The new suite reads working source by default. For pre-merge verification only, `LOOPBACK_FIXED_SOURCE` selects the prepared transport and keeps other modules on the reviewed revision.

Pre-merge result: strict standalone transport TypeScript passed and all 17 acceptance tests passed, including actual loopback streaming deadline/socket cleanup, exact UTF-8 request boundaries, and late-event handling. After merge `b331cc9729fd86c21268ad802d276b0081110da1`, the correction was applied to the actual checkout and all 17 regressions passed again against working source. The broader targets harness passed strict TypeScript and 156 tests across six files, none skipped. These are local checks, not deployed acceptance. No external endpoints or providers were contacted.

Actual-checkout commands:

```sh
node --test tests/track-b/loopback-transport-review/regression.cjs
node tests/track-b/run-checks.mjs --components targets --track-a-ref b331cc9729fd86c21268ad802d276b0081110da1 --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules
```

The correction leaves all HTTPS implementation bytes unchanged. The local default/max deadline is 120 seconds, request cap 256,000 bytes and response cap 1,000,000 bytes; callers may configure smaller positive integer limits. Rejected credential/header/encoding input produces safe fixed codes. App/cron construction and operator-only destination admission remain unchanged.
