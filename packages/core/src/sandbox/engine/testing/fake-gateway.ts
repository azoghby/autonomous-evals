/** Deterministic fake of packages/core/src/ai/gateway.ts for engine tests. */
import { GatewayError, type GatewayResult, type GenerateStructuredArgs, type GenerateTextArgs, type StructuredResult } from "../../../ai/gateway";
import { resolveModel } from "../../../ai/models";
import type { EngineGateway } from "../types";

export interface FakeCall { kind: "text" | "structured"; model: string; system?: string; prompt: string; agent?: string; temperature?: number }
/** Return a value (object for structured, string for text). Throw to simulate a failure. */
export type FakeHandler = (call: FakeCall) => unknown;

export function fakeGateway(handler: FakeHandler, opts: { microUsdPerCall?: number } = {}): EngineGateway & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const cost = opts.microUsdPerCall ?? 100;
  const base = async (args: GenerateTextArgs, kind: FakeCall["kind"]): Promise<{ value: unknown; res: GatewayResult }> => {
    if (args.ctx.budgetMicroUsd !== undefined && args.ctx.budgetMicroUsd <= 0) {
      throw new GatewayError("budget_exhausted", "Job budget exhausted; refusing model call.");
    }
    const model = resolveModel(args.model ?? "sonnet").vercel;
    const call: FakeCall = { kind, model, system: args.system, prompt: args.prompt, agent: args.agent, temperature: args.temperature };
    calls.push(call);
    const value = await handler(call);
    await args.ctx.recordCost({ source: "ai_gateway", agent: args.agent, microUsd: cost, meta: { model, fake: true } });
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return { value, res: { text, provider: "vercel", model, inputTokens: 10, outputTokens: 10, microUsd: cost, costBasis: "list_price_estimate", latencyMs: 1 } };
  };
  return {
    calls,
    async generateText(args: GenerateTextArgs): Promise<GatewayResult> {
      return (await base(args, "text")).res;
    },
    async generateStructured<T>(args: GenerateStructuredArgs<T>): Promise<StructuredResult<T>> {
      const { value, res } = await base(args, "structured");
      const check = args.schema.safeParse(typeof value === "string" ? JSON.parse(value) : value);
      if (!check.success) throw new GatewayError("malformed_output", `fake: schema validation failed: ${check.error.message.slice(0, 300)}`);
      return { ...res, object: check.data };
    },
  } as EngineGateway & { calls: FakeCall[] };
}

/** A ctx that records costs in memory. */
export function memoryCtx(budgetMicroUsd = 5_000_000) {
  const costs: number[] = [];
  let spent = 0;
  return {
    costs,
    get budgetMicroUsd() { return budgetMicroUsd - spent; },
    async recordCost(e: { microUsd: number }) { costs.push(e.microUsd); spent += e.microUsd; },
  };
}
