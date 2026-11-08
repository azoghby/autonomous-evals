# Track A runtime/media compatibility checkpoint

Inspected local Track A `875ceef6a743df41736ee55c4145ca794e0854a8` after its ingest, media, Neon runtime and sandbox UI commits. No Track A sources changed. The shared spec retains `sandbox-spec-v1` while adding optional `ToolCallRecord.executed`, optional query parameters, and sample-row shape documentation.

Parent validation:

```sh
TRACK_A_REF=875ceef TRACK_B_NODE_MODULES=/tmp/sandbox-generation-deps.cBCEai/node_modules node tests/track-b/sandbox-integration/run.mjs
```

Strict transitive TypeScript and 13 offline integration tests passed against exact current spec SHA-256 `4177bc33e564080fc19ae6174e8efbbddaf6fb2a4889238f047430276b68ec74`. This substitutes the real shared contract, not the runtime: the integration tests still use their local SQL worlds and scripted providers. It does not establish live Neon compatibility.

## Available platform surfaces

The runtime exposes `sandbox_diff(table_name, pk, change, before, after)` and `sandbox_baseline`. Diff coverage includes all non-sandbox user-schema tables. `diff()` samples only five rows per table; samples must not establish complete allowed-write evidence. Grader queries use SELECT/WITH, a read-only transaction, five-second timeout and a 5000-row output cap. Aggregate predicates over the full relation can avoid inferring completeness from capped row exports. The stateful-grading team is binding approved predicates to run/scenario/suite/environment authority.

Media provides rendered documents, Gateway TTS/STT/vision/image operations, oracle/perception helpers and a chat-audio driver. Realtime remains a typed interface; whole-response audio timing is only an upper bound for first-audio latency. The multimodal team is reusing these boundaries and adding durable authority, metering, replay, ground-truth and execution integration rather than treating protocol serialization as live media proof.

## Owner follow-ups found by source inspection

- `sandbox/runtime/run.ts` currently implements `query: (sql)` and forwards an empty parameter list to `conn.query`, although the new shared interface accepts `params`. Positional query parameters must not be used by B until forwarded and tested; never interpolate customer values to work around this. This is a source-observed incompatibility, not a newly executed live SQL finding.
- The optional `executed` property is not assigned in the inspected `run.ts` result construction. Consumers must not assume an absent flag proves execution; existing error/fault signals remain relevant. A fault-short-circuited verification call must not satisfy a successful-before-write requirement.
- The platform disposes trial databases, while B grades retained final snapshots after execution cleanup. An immutable pre-disposal snapshot/receipt and read-only recovery API remain required; a summary/sample or a new empty world is not equivalent evidence.
- Query readonly/isolation and source SQL validation remain runtime authority, not engine permissions. Review same-table collateral predicates, outbox side effects, disposal/reaper and cross-process budget ownership before stateful acceptance.

The existing A UI sample service is not evidence that the B engine is wired. Owner application composition and real protocol/runtime acceptance remain separate gates.
