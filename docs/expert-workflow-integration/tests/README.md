# Applied-source Workflow fixtures

Run against a staging tree containing the adopted overlay and mounted dependencies:

```sh
EXPERT_WORKFLOW_STAGE=/tmp/expert-workflow-mount-stage /tmp/workflow-bootstrap.JpxCTM/node_modules/.bin/vitest run --config docs/expert-workflow-integration/tests/vitest.config.mjs
```

The config resolves source imports into the staging tree; tests never patch staged source. `job-gate.test.ts` executes the actual job Workflow, actual decisions, and actual expert-data steps while replacing Workflow hooks/timers and all external lifecycle/evaluation effects. `plan-gate.test.ts` executes the actual trusted-plan gate with fake SQL/producer. `producer-mode.test.ts` executes the actual producer's mode guard with agent construction and owner I/O mocked. No network, email, payment, or provider calls occur.

These are ordinary function fixtures, not a hosted durable-runtime acceptance test. They do not establish fresh-secret enforcement across actual database/provider transactions; separate owner integration tests cover those boundaries.
