# Appendable frozen12 remediation integration

Base: `48519bf16e04bce3397ceaeb8abea060d2636263`. ECC is disabled.
Only this documentation tree and new core modules under
`packages/core/src/evals/remediation/accounting/` are owned by this delivery.
Application changes are an unapplied patch artifact. No cloud/provider call,
secret retrieval, spending, outreach, push, PR, migration deployment or app-owned
source edit is authorized or performed.

## Composition

[SERIES.json](SERIES.json) records the base and append. Start with the exact
prerequisite `docs/workflow-integration/SERIES.json`; integrate current base core
sources and the new accounting directory, then check/apply
[003-remediation.patch](app/003-remediation.patch). Do not change the pinned
prerequisite manifest or duplicate the data-bridge team's implementation.
`node docs/workflow-remediation-integration/stage.mjs` composes this offline with
Git archives and `git apply --check` in a disposable directory. It creates no
checkout, reapplies the prerequisite producer Calendar core hunks after the
current-core overlay, installs nothing and runs no migration on deployed storage. The optional
SQL migration in the app artifact needs separate owner review/application.

The secured adapter supports only full replacement prompt patches to an admitted
stateless chat-completions target. The saved original frozen suite and confirmed
objective failure are the verification criteria. A trial executes all twelve
original scenarios, retaining full detailed verification and local application
receipts. No fake remote attestation or arbitrary tools/code patches are supplied.
Historical Trace evidence and unsupported kinds cannot become verified repairs.
The appended pack stays separately gated; base12 success establishes no full-pack
success. Judge-dependent unassessed checks remain unassessed.

## Validation and retained evidence

Run the scoped offline harness with existing dependencies:

```sh
WORKFLOW_NODE_MODULES=/absolute/path/to/existing/node_modules \
  node docs/workflow-remediation-integration/verification/run.mjs
```

The harness tests the applied artifact and real core remediation factory, secured
adapter and SQL accounting. It selects only remediation/adapter/accounting and
new app tests, runs one worker, rejects skipped/todo tests, and uses no provider.
See [verification results](verification/RESULTS.md) for actual outcomes and exact
limits; tests are fixture evidence, not completed customer/live remediation.

[Acceptance boundaries](ACCEPTANCE.md) records the required complete baseline/trial
receipt/accounting evidence, trust boundary and remaining hosted acceptance.
Unknown provider amounts stay unknown; retained accounting evidence is distinct
from the existing measured Naive-session ledger. Priced delivery must use the same
global keyed Workflow cost protocol as every existing writer.
