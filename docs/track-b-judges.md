# AI Gateway rubric judge

`createGatewayJudge` in `packages/core/src/judges/gateway.ts` returns a bounded subjective judge. Track A supplies an explicitly configured model, fresh API key/OIDC token, atomic operation authorization, and durable usage recording. Customer endpoint credentials are not accepted by this interface.

The implementation uses Vercel's documented [OpenAI-compatible Chat Completions endpoint](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions). Requests use JSON Schema output, a 30-second deadline, no redirects or automatic retries, and a 64 KB response limit. Unsupported schema/model combinations fail visibly rather than silently switching providers.

Return values distinguish `passed`, `rubric_concern`, and `inconclusive`. Factual correctness without reference text is not assessed and makes no provider call. Evidence quotations must exist in the submitted response or reference. Malformed results, invented quotations, provider refusals, and failures throw `JudgeUnavailableError`; callers must keep these as judge/infrastructure limitations, not objective customer failures.

`authorize(operationId)` must durably reserve/authorize a unique invocation and reject duplicate or ambiguous replays. `recordUsage` receives known token counts when available and explicitly unknown monetary cost. Reconcile gateway billing separately; never convert absent price data into zero dollars. A failed usage write blocks successful return. The production adapter must retain authorization on ambiguous failures and persist successful judgments before Workflow advancement.

Provider response IDs and token counts are retained even when verdict validation rejects a truncated or malformed result. Missing token counts stay unknown, not zero. Refusals are rejected even if content resembles a valid verdict.

Validation: fifteen injected-transport cases and strict TypeScript checks pass. No live Gateway request has been made; live configuration and end-to-end Text Eval wiring remain unverified.
