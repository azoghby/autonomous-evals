# Controlled fixture protocol verification

Run offline, from repository root:

```sh
ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules \
  node --test tests/track-b/controlled-acceptance-targets/route.test.mjs
```

The directory must contain existing TypeScript, Zod and ipaddr.js dependencies used by the existing provider runner. No install, server, HTTP request, provider call, credential read, secret file or deployment is needed. A synthetic token is set in memory for direct-handler authorization checks and restored afterward. Temporary files contain only transpiled sources and module metadata.

The test independently reads the repository's accepted Lumen Text design, recomputes its canonical SHA-256, and also uses the actual core admission verifier. It invokes the staged Next route functions with Web Request/Response objects. All twelve fixed responses are checked against the unchanged actual objective evaluator and an independent factual oracle; all twelve buggy responses must fail an objective check. The actual core Text adapter parses each version's handler response through an explicitly local in-memory transport. This does not exercise secure HTTPS transport.

Other assertions cover exact model separation, exact two-message fixture admission, unknown/system-edited/generic/tool request rejection, completion caps, UTF-8 byte bounds, oversized stream cancellation, auth before body parsing, independent bearer configuration, disable/rotation, private no-store fixed errors, explicit fixture provenance, and interleaved concurrent repeatability. Response usage must be absent rather than fabricated. All fixed fixture metadata states `internal_fixture`, `deterministic_canned`, `live_llm:false` and `remote_prompt_patch_attestation:false`.

`results.txt` records **15 passed, zero skipped/todo**. This is direct runtime verification through TypeScript transpilation, not strict application typecheck, a deployed Next server, production TLS, SQL engine, Gateway judgment, live LLM behavior, customer intelligence validation, remote prompt patch attestation or complete application acceptance. Existing acceptance runner files and assertions remain unchanged.

Calendar tool calls are deliberately unsupported and rejected. A separate implementation must bind reviewed `calendarAcceptanceScenarios()` prompts and `referenceCalls` to exact system/tool/message transcripts; reconstruct progress only from the request's assistant/tool messages; validate tool call ids, arguments and tool results before a terminal reply; and test with the actual SQL simulator and unchanged state graders. It must retain `internal_fixture` origin and must not fabricate an `actual_app_provider` evidence source. See the deployment handoff under `docs/controlled-acceptance-targets/` for the broader app-owned integration boundary.
