/**
 * One live Naïve smoke through the real services (EVAL_SERVICES=real path, outside a Workflow):
 * qualify + renderReport on a fresh internal-fixture test job (customer sandbox-e2e@example.com),
 * then verifies that agent session ids were persisted (agent_persistence.tasks) and costs recorded (costs).
 *
 * Usage: npx tsx --env-file=.env scripts/naive-smoke.ts [--budget-usd 1]
 * Spends real money (a few cents). Prints ids, statuses and amounts only.
 */
import { randomUUID } from "node:crypto";
import { ensureFixtureJob, withPendingRetry } from "./real-services-lib";

const DEFAULT_BUDGET_USD = 1;
const SMOKE_TRACE = JSON.stringify([
  { role: "user", content: "Book me a table for two at 7pm." },
  { role: "tool", name: "book_table", content: "{\"error\":\"no availability\"}" },
  { role: "assistant", content: "Done! Your table for two at 7pm is confirmed." },
]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--budget-usd");
  const budgetMicroUsd = Math.round(Number(i >= 0 ? args[i + 1] : DEFAULT_BUDGET_USD) * 1e6);
  if (!Number.isSafeInteger(budgetMicroUsd) || budgetMicroUsd <= 0 || budgetMicroUsd > 2_000_000) throw new Error("--budget-usd must be in (0, 2]");

  const { evalServices } = await import("../packages/core/src/integration/eval-services");
  const { db, schema } = await import("../packages/core/src/db/client");
  const { sql } = await import("drizzle-orm");
  const { IntakeInput } = await import("../packages/core/src/contracts/index");
  const services = withPendingRetry(evalServices);
  const jobId = await ensureFixtureJob(randomUUID());
  console.log(`job ${jobId} (fixture, environment=test) budget=$${(budgetMicroUsd / 1e6).toFixed(2)}`);

  let spent = 0;
  const ctx = {
    jobId, environment: "test" as const, budgetMicroUsd,
    async recordCost(entry: { source: string; agent?: string; sessionId?: string; microUsd: number; meta: Record<string, unknown> }) {
      spent += entry.microUsd;
      await db().insert(schema.costs).values({ jobId, source: entry.source, agent: entry.agent ?? null, sessionId: entry.sessionId ?? null, microUsd: entry.microUsd, meta: entry.meta });
    },
    async recordProgress(milestone: string, message: string) {
      await db().insert(schema.progressEvents).values({ jobId, milestone: milestone.slice(0, 100), message: message.slice(0, 1000) });
    },
  };

  const intake = IntakeInput.parse({ package: "trace_audit", trace: SMOKE_TRACE, systemPrompt: "Only confirm bookings the tool confirms.", authorizedToTest: true });
  const q = await services.qualify(ctx, intake, []);
  console.log(`qualify: decision=${q.decision} package=${q.package} questions=${q.questions.length}`);
  const report = await services.renderReport(ctx, { intake, findings: [] });
  console.log(`renderReport: markdown=${report.markdown.length}B html=${report.html.length}B jobId match=${report.jobId === jobId}`);

  const tasks = await db().execute(sql`select task_key, record->>'state' as state, record->>'sessionId' as session_id from agent_persistence.tasks where task_key like ${`${jobId}:%`} order by task_key`);
  const costs = await db().select({ source: schema.costs.source, agent: schema.costs.agent, sessionId: schema.costs.sessionId, microUsd: schema.costs.microUsd })
    .from(schema.costs).where(sql`${schema.costs.jobId} = ${jobId}`);
  for (const t of tasks.rows as Array<{ task_key: string; state: string; session_id: string | null }>) console.log(`task ${t.task_key.slice(jobId.length + 1)} state=${t.state} session=${t.session_id}`);
  for (const c of costs) console.log(`cost source=${c.source} agent=${c.agent} session=${c.sessionId} $${(c.microUsd / 1e6).toFixed(4)}`);
  const ok = tasks.rows.length >= 2 && (tasks.rows as Array<{ session_id: string | null }>).every((t) => t.session_id)
    && costs.length >= 2 && costs.every((c) => c.source === "naive" && c.sessionId);
  console.log(`${ok ? "PASS" : "FAIL"}: ${tasks.rows.length} task(s) with session ids, ${costs.length} naive cost row(s), total $${(spent / 1e6).toFixed(4)}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : "smoke failed");
  process.exit(1);
});
