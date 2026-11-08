# Offline controlled Calendar fixtures

Run with existing offline dependencies only:

```sh
ACCEPTANCE_DEPENDENCIES=/tmp/track-b-harness/node_modules node tests/track-b/controlled-calendar-targets/run.mjs
```

The runner starts no server and installs nothing. Tests transpile and import the actual artifact Next route functions, use the actual ChatCompletionsClient payload/parser and runCalendarScenario, and execute CalendarSimulator/PostgresCalendarStore and gradeCalendarState against actual PGlite SQL. All 24 scenario/version executions run serially against one PGlite backend. Parallel tests exercise route functions only; this does not prove native PostgreSQL multi-session locking.

All twelve canonical fixed scenarios must pass SQL. Buggy booking must fail count/matching_events; buggy cancel must fail count/event. The other ten buggy scenarios preserve the full inventory and expected passes. Auth, private safe errors, token/byte/turn bounds, transcript correlation and concurrent scenario/version isolation are also checked.

The explicitly named QUARANTINED test demonstrates that a shape-valid invented created-event UUID can be accepted without execution: transcript validation cannot attest tool execution, and the response must mark tool_execution_attestation:false. This is a documented limitation, not SQL or application acceptance. Arbitrary system prompts, default cap1024, and the generic Reply OK connectivity probe are denied. Configure the trusted application driver with the exact system and maxCompletionTokens:512; keep SQL grading and receipts in that driver.

Everything here is controlled internal fixture evidence. Hosted HTTP, real Gateway acceptance, owner application execution/restart/private report/security checks, LLM inference and remote prompt patch attestation remain unproven by these tests.
