/* Run: npx tsx scripts/ai-smoke.ts   (spends fractions of a cent per provider) */
import { config } from "dotenv";
import { z } from "zod";
import { generateStructured, GatewayError, type GatewayProvider } from "../packages/core/src/ai/gateway";

for (const f of [".env", "apps/web/.env.local", "apps/web/.env.vercel.local"]) config({ path: f, override: false, quiet: true });

const schema = z.object({ answer: z.number().int(), word: z.string().min(1) });

async function main() {
  let failures = 0;
  for (const provider of ["vercel", "neon"] as GatewayProvider[]) {
    const recorded: unknown[] = [];
    try {
      const r = await generateStructured({
        model: "haiku",
        providers: [provider],
        system: "You are a terse assistant.",
        prompt: 'What is 2+3? Put the number in "answer" and the English word for it in "word".',
        schema,
        agent: "judge",
        maxOutputTokens: 100,
        timeoutMs: 30_000,
        ctx: { recordCost: async (e) => { recorded.push(e); } },
      });
      console.log(JSON.stringify({
        provider: r.provider, model: r.model, latencyMs: r.latencyMs, microUsd: r.microUsd, costBasis: r.costBasis,
        tokens: { in: r.inputTokens, out: r.outputTokens }, schemaValid: true, object: r.object, costEntriesRecorded: recorded.length,
      }));
    } catch (e) {
      failures++;
      const code = e instanceof GatewayError ? e.code : "error";
      console.log(JSON.stringify({ provider, ok: false, code, message: (e as Error).message.slice(0, 300) }));
    }
  }
  process.exit(failures === 2 ? 1 : 0);
}
main();
