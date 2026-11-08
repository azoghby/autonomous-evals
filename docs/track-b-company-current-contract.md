# Current company integration contract

Reviewed source: `71435dce731d4dd3d27c1df6e49886f3c78b00c6`. This is an owner handoff, not app activation or live acceptance.

## Preserve the existing execution path

Company onboarding already calls `getSandboxService` → `createEngineSandboxService` → `workflowSandboxExecutor` → sandbox suite/run Workflows. These use `@ae/core/sandbox/engine/*`. The historical jobs-based `CurrentOwnerLoader` artifact must not be enabled as a second evaluator for those same runs. Its fixed-price payment contract is not the sandbox subscription/plan contract. Company conversational expenses and customer suite/run expenses have separate budget scopes.

The next owner integration belongs at `apps/web/src/server/sandbox/pipeline.ts:runScenarioTrials`. That function currently calls `runSuite` before persisting `putRunResult`; `runSandboxScenarioStep.maxRetries = 1` allows retry after interruption. This source review does not itself prove a reproduced production duplicate. A durable adapter must bind current owner, run, scenario, environment, versions, k and world before any dispatch; completed replay restores the same result, while pending/ambiguous work remains fenced and unresolved. Reauthorize both dispatch and replay. A generic retryable exception must not turn ambiguity into a new paid attempt.

Reusable B primitive: `PostgresTextCheckpointStore` in `evals/integration/checkpoints.ts`. Further owner work: immutable onboarding startRun dispatch identity (conversation runId is written after startRun), transactional keyed sandbox cost settlement, and real gate/approval/snapshot bridges before adopting the full B engine. Do not fabricate remediation receipt fields or convert a stored validated boolean into a gate proof.

## Bounded OpenAPI text retrieval

`HttpsPublicSourceTransport.getText(endpoint): Promise<string>` now uses the same validated and DNS-pinned GET as existing JSON discovery. It supports YAML/JSON/raw UTF-8 documents, preserving the decoded BOM and whitespace. Invalid UTF-8 rejects with `invalid_utf8`; no parser or source-permission approval is implied. Existing `get()` JSON behavior is unchanged.

Track A can replace the validate-then-global-fetch implementation of `company/onboarding-intake.ts:defaultFetchSpec` with this port (owner applies):

```ts
import { HttpsPublicSourceTransport } from '@ae/core/targets/public-source';

export const defaultFetchSpec: FetchSpec = async url => {
  try {
    const origin = new URL(url).origin;
    return await new HttpsPublicSourceTransport(origin, {
      timeoutMs: 10_000,
      maxResponseBytes: 500_000,
      userAgent: 'StandardEvals-OpenAPI/1.0',
    }).getText(url);
  } catch {
    throw new IntakeError('I could not retrieve that public HTTPS spec within the size and time limits.', 'openapiUrl');
  }
};
```

This intentionally requires HTTPS port 443 and rejects credentials, fragments, redirects, private/mixed DNS answers, unsupported content encodings, and bodies above the byte limit as they stream. DNS time counts toward the deadline. Socket destination is the validated IP; Host, SNI and certificate identity remain the original hostname. Query strings are allowed only on that selected origin. This is an unauthenticated public-document port, not permission to retrieve private sources.

The current A implementation checks URL/DNS separately and then calls global fetch followed by res.text(); that does not reuse the validated address and bounds body length only after allocation. No live exploit was attempted. Actual Track A files remain unchanged.

## Verification

Mocked-socket regressions cover exact YAML/BOM/empty text, byte limits with multibyte UTF-8, invalid encoding, DNS pinning, cross-origin rejection, redirects and deadlines. Existing JSON transport regressions remain selected. The full targets harness also contains local loopback TLS tests; it makes no external provider calls. Hosted source retrieval and application adoption remain unverified.

Validation command:

```sh
node tests/track-b/run-checks.mjs --components targets \
  --track-a-ref 71435dce731d4dd3d27c1df6e49886f3c78b00c6 \
  --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules \
  --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules
```

Strict compilation and 161 tests across six files passed, none skipped. Required root typecheck/test commands were also attempted offline: local TypeScript/Vitest executables remain unavailable, so no current full-app pass is claimed.
