# Independent remediation target review

Parent fix: configured API keys shorter than four characters are now refused at
construction, before accounting or transport. The three R2 characterizations are
refusal regressions. Strict revalidation passed **627 tests with one explicit G1
expected failure**, none skipped. G1 remains the deliberate dishonest privileged
port/remote-attestation trust limitation, not a passing security guarantee.
The concrete adapter is exported through the server-only `evals/index.ts` entry.

Reviewed original `e0033a40a4fc37a9eba326975ed81f608ce2bc6e`, cherry-picked without conflict as `5d07f8764d4a74a732bfe0f11a1783614f5e083a` onto review base `e47a852`. Production code and original tests were not edited. The separate review artifact commit owns only this document and `tests/track-b/remediation-target-review/**`. ECC was disabled. An independent security child performed read-only inspection; the reviewer integrated its finding and executable repros.

Disposition: one low-severity bounded credential exclusion defect (R2) should receive a small parent fix. The local serialization and durable intent boundaries otherwise pass the stated offline checks. This does not accept a production accounting deployment or remotely attest target behavior.

## R2 — allowed short endpoint credentials bypass content exclusion (P3)

`packages/core/src/targets/remediation.ts:74` accepts nonempty printable credentials of one to three characters. Lines 105–107, 127 and 135–146 pass that credential to `containsSecret`, but `packages/core/src/agents/redact.ts` constructs known-secret variants only from strings of length at least four. Thus the documented exclusion of the configured credential from patches, payloads, receipts and results has an allowed-configuration hole.

Minimal repro, using a synthetic credential only:

1. Construct the canonical fixture with `endpoint.apiKey = 'abc'` and `currentSecrets()` returning `[]`.
2. Set `patch.patch` and `request.systemPrompt` to `Always include READY and abc.` and recompute `patchDigest`.
3. Send with the injected offline transport through the real text/chat serialization.
4. The send succeeds, dispatches that system message and returns a receipt containing `abc`. The four-character `abcd` control refuses before transport.
5. Independently return completion text `READY abc`; the adapter returns it successfully.

Evidence: `review.test.ts:77` and `review.test.ts:94` are explicitly labeled **CHARACTERIZATION R2**, asserting the observed unsafe behavior rather than pretending it is acceptance. Five other new cases are acceptance checks. This is not evidence that an untrusted caller can choose the server's credential or discover an unknown credential. It requires an allowed short credential and matching patch/response content; real provider tokens usually exceed this length. Nevertheless, an endpoint accepting a short shared credential is permitted by this constructor.

Suggested small fix: refuse configured credentials below four characters at construction (align with current-secret policy), or explicitly match every accepted credential in encoded/plain content. Convert the short-key characterizations into refusal regressions after the fix. No production fix was made in this review.

## Accepted offline properties and limits

- **Immutable scope and scenario data:** construction JSON-detaches and recursively freezes scope/limits after admitted-suite and baseline validation (`remediation.ts:69–84`). Send JSON-detaches input before its first await (`:96`). The new mutation test changes caller prompt, patch, limits, check description and callback property during the policy await; the original prompt/cap/callback remain effective. Actual payload messages and dispatch evidence are frozen. Original tests exercise distinct original users across all twelve scenarios and unchanged criteria.
- **Exact patch and payload-derived receipts:** the actual `createTextTarget` → platform adapter → `ChatCompletionsClient` serialization is compared in full against model, replacement system message, exact original user message, completion cap and `store:false` (`:114–118`). The same frozen value is dispatched; receipt system text comes from its system message (`:137–139`). Original tests cover mismatched patch/prompt/digest/user/scenario/run/baseline/suite and cross-target/version/environment/trial/finding identity. This is full prompt replacement, with no diff interpretation, deployed mutation, tool invocation or provider thread handle.
- **Default transport:** explicit `HttpsJsonTransport` and per-adapter `TargetGate` (`:91`); actual default transport refuses a literal private IP before network/DNS in the new offline test. Existing transport tests use injected DNS and mocked HTTPS to cover URL normalization, mixed/public address policy, pinned address, original-host TLS identity, no pooling/proxy/redirect, byte bounds and deadlines. No external transport test was run. The final harness excludes the existing loopback TLS test.
- **Secret policy:** mandatory current policy is checked both before intent work and after the durable pre-dispatch hook. Original tests verify policy rotation at that hook, callback failure, configured credential exclusion for normal-length keys, secret responses and fixed safe errors. R2 is the explicit exception. An authenticated resolver must refresh `knownSecrets` on every factory replay; the adapter's `currentSecrets` callback is a send policy, not a replay callback. The SQL acceptance test confirms a refreshed resolver policy blocks stored replay.
- **Reservation/evidence identity:** new PGlite integration checks that factory target intent is already pending, then SQL-links `beforeDispatch` evidence to exactly the operation ID and input digest reserved by `authorize`. All twelve observed payload digests equal the actual outgoing bodies. SQL retains usage and excludes the synthetic credential. A fresh factory and fresh adapter replay the same result with zero budget, without rerunning engineer, authorization or target transport.
- **Ambiguity and concurrency:** simultaneous identical sends on one adapter cause one dispatch. A received response followed by lost usage acknowledgement and even failed `ambiguous` callback leaves the factory SQL intent ambiguous. A fresh adapter/factory cannot redispatch it. Original tests cover transport/pre-dispatch/usage failures, timeout, late usage, unknown usage and incomplete completion. Default transport aborts; injected callbacks/transports can continue after deadlines and require durable backend reconciliation.
- **Accounting remains a trusted integration seam:** the new SQL reservation/usage table is review infrastructure, not a production ledger or pricing implementation. Mandatory callbacks cannot prove their own durability; host accounting must atomically reserve bounded amounts, retain holds, price measured usage, deduplicate/outbox late observations and survive process loss. `costs:[]` means no Naive-session entries, not zero HTTP spend. Factory `recordCost` does not represent these HTTP costs. No claims about actual monetary settlement or production spend are accepted here.

## G1 and trust boundary characterization

The original `tests/track-b/remediation-review/review.test.ts` G1 `it.fails` remains unchanged and is run by the new harness. A dishonest privileged trial port still supplies fabricated passing output and echoed receipts, causing `verified` even though its desired security assertion expects `not_verified`. It is an explicit expected failure, not an acceptance pass or evidence of a caller exploit.

The new adapter supplies local evidence of the actual body handed to the trusted transport. A dishonest injected transport can ignore that body. An authenticated resolver can lie about canonical version/model, authorization, endpoint isolation or scenario ownership. A remote endpoint can ignore the prompt, use hidden state or serve another model. None is remotely attested by these receipts. The original G1 limitation is preserved.

## Reproduce and validation

The fixture setup reuses the reviewed adapter's admitted twelve-scenario fixture; the independent assertions and SQL accounting checks live in the owned review file. The harness stages current source and original eval/judge/target tests in a temporary directory, overlays pinned local Track A contracts, includes the original factory review unchanged, and runs strict TypeScript followed by Vitest. It installs/fetches nothing and rejects skipped/todo tests.

```sh
TRACK_A_REF=769537d0fce974b355999c8cbcc637796074d0c2 \
  REMEDIATION_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules \
  node tests/track-b/remediation-target-review/run.mjs
```

The first broad staging run inadvertently included the existing `targets/tls.test.ts`: seven tests opened loopback HTTPS sockets and generated temporary synthetic test keys/certificates. It contacted no external endpoint. The final harness explicitly excludes that file to honor the no-network constraint. No provider, external network, cloud, real secret, spend, outreach, push or PR was used. Production files remain exactly the cherry-picked original.

Final validation against the unchanged reviewed production tree: strict TypeScript succeeded; **35 files, 627 passing assertions and 1 explicit G1 expected failure (628 total), zero skipped/todo**. Includes 8 new review cases (5 acceptance and 3 R2 characterizations), 31 original secured-adapter cases, 23 original factory cases, and the unchanged 30-case independent factory review. The first full run including loopback TLS had 36 files, 634 passes and the same one G1 expected failure. The final no-socket staging run completed in 43.15 seconds. `node --check` for the harness and `git diff --check` also passed. Production adapter/test/document content matches original `e0033a4` exactly.
