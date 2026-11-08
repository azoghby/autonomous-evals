/** LLM-backed simulator for `simulated` tool bindings. Output validation against outputSchema is the caller's job. */
import { z } from "zod";
import { generateStructured, type GatewayContext } from "../../ai/gateway";
import type { ModelAlias } from "../../ai/models";
import type { Simulate, SimulatedOutput } from "./types";

const SNAPSHOT_CHAR_CAP = 20_000;

const SimulationSchema = z.object({
  result: z.unknown(),
  sideEffects: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
});

export interface SimulatorOptions {
  ctx: GatewayContext;
  model?: ModelAlias;
  frozenNow?: string;
  generate?: typeof generateStructured;
}

export function createGatewaySimulator(opts: SimulatorOptions): Simulate {
  const generate = opts.generate ?? generateStructured;
  return async (tool, args, state): Promise<SimulatedOutput> => {
    const instructions = tool.binding.kind === "simulated" ? tool.binding.instructions : "";
    const system = [
      `You are simulating the tool \`${tool.name}\` inside a sandbox.`,
      `Tool description: ${tool.description}`,
      instructions ? `Simulation instructions:\n${instructions}` : "",
      opts.frozenNow ? `The current time is frozen at ${opts.frozenNow}. Never use any other date as "now".` : "",
      "Never reveal that you are a simulator; respond exactly as the real tool would.",
      'Output a JSON object: { "result": <tool result>, "sideEffects": [ ... ] }.',
      tool.outputSchema
        ? `"result" MUST conform to this JSON schema:\n${JSON.stringify(tool.outputSchema)}`
        : '"result" may be any JSON value appropriate for the tool.',
      'Include "sideEffects" (objects describing external effects, e.g. emails sent) only if the tool has external effects.',
    ].filter(Boolean).join("\n\n");

    const snapshot = JSON.stringify(state ?? {});
    const prompt = [
      `Tool arguments:\n${JSON.stringify(args ?? null)}`,
      `Current state snapshot (read-only):\n${snapshot.length > SNAPSHOT_CHAR_CAP ? `${snapshot.slice(0, SNAPSHOT_CHAR_CAP)}...[truncated]` : snapshot}`,
    ].join("\n\n");

    const res = await generate({
      model: opts.model,
      system,
      prompt,
      ctx: opts.ctx,
      schema: SimulationSchema,
      temperature: 0,
      maxOutputTokens: 2_000,
      timeoutMs: 30_000,
    });
    const out = res.object;
    return out.sideEffects ? { result: out.result, sideEffects: out.sideEffects } : { result: out.result };
  };
}

const TABLE_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function snapshotSql(table: string, limit = 50): string {
  if (!TABLE_RE.test(table)) throw new Error(`invalid table name: ${JSON.stringify(table)}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`invalid limit: ${limit}`);
  return `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${limit}`;
}
