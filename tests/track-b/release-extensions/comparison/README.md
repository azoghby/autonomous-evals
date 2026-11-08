# Combined comparison and offline compile verification

Run against a fresh `stageExtended()` result, or set `EXTENSION_STAGE` to a retained extended stage:

```sh
node tests/track-b/release-extensions/comparison/run.mjs
node tests/track-b/release-extensions/comparison/build.mjs
```

`WORKFLOW_INSTALLED_WORKSPACE` defaults to the retained offline workspace `/tmp/workflow-bootstrap.JpxCTM`. `CHAT_FONT_CACHE` can select retained Next Geist CSS/font assets. No install or remote font request is allowed. `EXTENSION_COMPARISON_OUTPUT` and `EXTENSION_BUILD_OUTPUT` override the evidence destinations. `build.mjs --build-only` skips Vitest but retains the Calendar route/budget checks and every compilation step.

The comparison runner retains all 15 original assertions in their original two files. Only the staged canonical migration filename changes. One additional regression exercises two distinct monitoring operations against the same reviewed frozen suite, retains the original rich baseline, asserts objective and unassessed rubric outcomes, and verifies that no suite/design checkpoint was fabricated. Its target fixture checks the pending tick rather than the first historical tick so both operations retain the original dispatch-before-claim assertion.

The build runner composes the lifecycle fixture adaptations with final pack/chat tests, then runs Calendar tests, production core TypeScript, Next route type generation, full application TypeScript, and Next's webpack/Workflow build. Outputs include exact commands, dependency versions, test counts, and exits. All application imports resolve to the combined disposable stage.

Monitoring remains base12 only: the runtime refuses augmented or hidden pack inventory before dispatch. The supported-pack reviewed-data wakeup test is in the lifecycle lane; these tests do not claim augmented-pack monitoring support. Judging and finding rerun remain separate extension seams. Monitoring notifications remain drafts (`sent: 0`); its actual cron helper requires configured authorization and fails closed when absent.

This uses preinstalled dependencies and retained fonts. It does not establish a fresh dependency install, native PostgreSQL locking, hosted access controls, real provider execution, deployed schema/configuration, or live acceptance. No credentials, network/provider calls, cloud migrations, outreach, push, or PR are part of these runners.

Final retained evidence: comparison **16/16**, combined lifecycle/pack **214/214**, authenticated chat **7/7**, Calendar route/budget **16/16**; zero failed/skipped. Core TypeScript, Next type generation, full app TypeScript, and Next webpack/Workflow build all exit 0. Installed versions: Next 16.4.5, React/React DOM 19.3.0, TypeScript 6.0.3, Workflow 5.4.0, managed-agents 0.12.3. `evidence/build/RESULTS.json` binds the successful build to application inventory SHA256 `85b0a7ee6f6eac3555151222af16c2d3c4f5af615612fca3eccee8f89ed8cb05` and records every command. Evidence contains the final successful run only.
