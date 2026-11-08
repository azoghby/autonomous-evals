# Secured remediation request adapter

`packages/core/src/targets/remediation.ts` exports `createRemediationTarget` directly.
No shared exports or factory changes are needed. This is an explicit server-only
constructor, without ambient credentials, resolver lookup strings or singleton state.
It supplies `AuthorizedRemediation.trial`; it does not supply authentication or
application bootstrap. Base: `9e27307` (parent R1 recovery fix included).

An authenticated server resolver must read the canonical job, confirmed finding,
binding, baseline run, admitted frozen suite and failing check IDs from authorized
storage on every invocation, including completed replay. Construct the adapter from
those exact detached values and the stable authorized trial ID. Supply the canonical
endpoint, model and credential from server configuration, with
`kind: 'stateless_chat_completions'` and `isolation: 'request_messages_only'` only when
that endpoint supports independent message-only requests. Never derive any of these
values from client target/version/environment/URL strings. Unsupported assistant
threads, tool execution, stored conversations, configuration-mutating endpoints and
unknown isolation semantics must be refused by the resolver; the adapter rejects
unsupported declared kinds and isolation modes. Version must change with relevant
model/configuration changes. The endpoint's stateless declaration is a trusted
resolver assertion, not remotely discovered or cryptographically attested.

```ts
// Inside the authenticated server resolver, using canonical stored values:
const trial = createRemediationTarget({
  scope: { job, finding, binding, original, trialId, endpoint: {
    kind: 'stateless_chat_completions', isolation: 'request_messages_only',
    url: canonical.url, model: canonical.model, apiKey: canonical.apiKey,
  } },
  currentSecrets: readCurrentAuthorizedSecretPolicy,
  limits: { timeoutMs: 30_000, maxCompletionTokens: 1024,
    maxRequestBytes: 256_000, maxResponseBytes: 1_000_000 },
  accounting: durableTargetAccounting,
});
return { job, finding, binding, original, knownSecrets, trial, judge, authorize };
```

The constructor detaches and recursively freezes its scope and limits. It verifies
suite admission/digest and baseline association/full coverage. Its fresh run ID uses
the same immutable finding/binding/original/trial identity as the remediation factory.
Every send checks that run, original scenario ID, exact frozen user input, baseline,
suite digest, strict prompt-patch schema/digest and replacement prompt agree. The
original frozen criteria remain unchanged. Deployed configuration is never written:
the existing `createTextTarget` and chat client serialize a replacement `system`
message followed by the unchanged `user` message, bounded completion tokens and
`store: false`. No tools, thread IDs or provider state handles are sent.

A transport wrapper validates the entire actual serialized body and dispatches that
same deeply frozen JSON value. Receipt prompt and patch digest derive from the
system message in that payload; canonical target/version/environment and trial/run/
scenario/baseline/suite associations come from the detached server scope. Model and
payload digest are bound in the accounting evidence. These are local trusted
request-dispatch receipts. A remote endpoint can ignore messages, use hidden state,
or serve a different model. No remote application, cryptographic, global correctness
or statistical reliability proof is claimed. The original G1 adversarial privileged
port expected failure remains fundamental: arbitrary dishonest trusted ports can
fabricate responses/receipts. This implementation closes the bounded local dispatch
adapter gap, not the entire G1 authenticated application integration gap.

Default transport is `HttpsJsonTransport` with explicit finite byte/time limits and
an explicit per-adapter `TargetGate`, without relying on its ambient global gate.
Existing public-address/DNS pinning, TLS identity, HTTPS, no redirects/proxies and
response bounds apply. Credentials remain in closures and are only passed to the
trusted transport. Construction/send errors expose fixed safe codes. Current secret
policy is refreshed before dispatch and again after the durable pre-dispatch hook;
known secrets and the credential are refused in patch/input/payload/results. The
transport injection is privileged server/test infrastructure, not a client option.
Injected transports must preserve these security semantics in deployment.

## Durable operation and usage seam

Factory durable intent, atomic authorization/reservation, budget and cross-process
idempotency remain `createRemediationServices` / `authorize` responsibilities. Call
this port only through that factory. A local per-scenario guard prevents concurrent
or repeated sends from one adapter instance; it does not replace durable fencing.
Do not treat a new adapter instance as permission to retry an unresolved intent.

All three accounting callbacks are mandatory. They receive credential-free immutable
`DispatchEvidence`, including the exact factory `operationId` and `inputDigest`,
payload digest and canonical job/target/version/environment/trial/run/scenario scope.
`beforeDispatch` must durably link this evidence to the existing bounded reservation,
verify its exact scope/digest and retain a dispatch intent. It must not authorize a
new operation or release factory reservations. `observed` must durably retain provider
usage before a response returns, and implement pricing/settlement/outbox as applicable.
Only validated nonnegative integer prompt/completion/total tokens with consistent
sum are exposed; absent/malformed usage is `null`, never a fabricated zero. Monetary
price is not inferred. Callback implementations and their accounting truth are part
of the authenticated server trust boundary.

`PaidResult.costs: []` means **no representable Naive-session cost entries**, not a
known total cost of zero. The existing `CostEntry` schema only represents measured
Naive sessions; HTTP target usage/cost must remain in this mandatory durable seam.
No HTTP cost is mislabeled as a session. Factory reports alone cannot provide a
complete monetary total until non-session usage accounting is integrated.

Transport rejection/timeout or callback failure yields a safe unresolved exception;
the factory keeps its intent ambiguous and never blindly repeats. `ambiguous` must
retain reservations and durable reconciliation/outbox state. If that callback also
fails, the port still throws, preserving the factory's unresolved intent. Each hook
and transport await has a finite deadline; this does not cancel a noncooperative
injected callback/transport. Late received usage still invokes `observed`; its backend
must safely handle late/duplicate observations and persist/reconcile even when the
request process dies. The secured default transport aborts timed-out network work.
A received malformed/incomplete completion returns the existing safe text error with
its dispatch receipt after measured usage persistence. None of these paths retries.

## Offline evidence and remaining integration

`targets/remediation.test.ts` uses real text/chat serialization, injected offline
transport observation, and real PGlite checkpoints for factory composition/replay.
It checks all twelve outgoing prompts, unchanged users, frozen criteria, model/token/
store fields and receipts; tampered user/prompt/patch digest/run/baseline/suite,
cross-version/environment/target/trial/finding identities, scope detachment,
unsupported/stateful construction, secret policy changes, callback/transport failure,
timeout/late usage and unknown usage. Existing target transport security tests and
original remediation tests remain unchanged.

No provider, cloud, secret access, spend, push, PR or deployed config change is part
of this work. Remaining application work: authenticated bootstrap and canonical
version/scenario ownership resolution, durable accounting callbacks and late usage
outbox, production reservation/settlement integration, remote-provider semantics and
live measured-cost acceptance. Offline mocks do not prove those responsibilities.

Validation commands (local dependencies reused; no installation/fetch):

```sh
node tests/track-b/run-checks.mjs --components targets,evals \
  --track-a-ref 769537d0fce974b355999c8cbcc637796074d0c2
TRACK_A_REF=769537d0fce974b355999c8cbcc637796074d0c2 \
  REMEDIATION_REVIEW_NODE_MODULES=/tmp/autonomous-evals-checks.m10du4/node_modules \
  node tests/track-b/remediation-review/run.mjs
```

Strict target/eval harness: 32 files, 566 passing tests, including 31 adapter tests
and 23 original remediation tests; none skipped. Independent review harness:
strict types, 28 files, 458 passes and one explicit expected failure (459 total).
That expected failure is the original adversarial privileged-port G1
characterization; R1 is an ordinary passing acceptance regression. No existing
factory, target, review test or expected-failure assertion was modified.
A separate temporary staged run of only `src/targets/remediation.test.ts` also passed
all 31 cases. The final twelve-scenario fixture uses distinct admitted user messages,
so per-scenario equality checks cannot pass by substituting a shared fixture string.
