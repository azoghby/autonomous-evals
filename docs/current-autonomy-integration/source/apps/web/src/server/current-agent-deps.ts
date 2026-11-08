import "server-only";
/** Hardened historical agent composition via current public core ports.
 * Explicit legacy rich use only; autonomous paths use the minted release runner. */
import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import type { ServiceContext } from "@ae/core/contracts/services";
import { db, schema } from "@ae/core/db/client";
import { createNaiveClient, createNaiveSessionsPort } from "@ae/core/agents/naive-adapter";
import { PostgresAgentTaskStore, PostgresBudgetLedger } from "@ae/core/agents/postgres-ports";
import { ensureAgents } from "@ae/core/agents/provision";
import { AgentSessionService } from "@ae/core/agents/session-service";
import { pooledCalendarDatabase } from "@ae/core/simulator/pool";
import type { TrackBServiceDeps } from "@ae/core/evals/service-adapter";
import { AgentRoleSchema, type AgentDirectory } from "@ae/core/evals/types";


import { EvalServiceConfigError, NAIVE_AGENT_ENV } from "@ae/core/integration/eval-services";

const AGENT_ENV = ["NAIVE_API_KEY", "DATABASE_URL", "NAIVE_BUDGET_PERIOD_ID", "NAIVE_IDEMPOTENCY_NAMESPACE", ...Object.values(NAIVE_AGENT_ENV)];

const missingFrom = (names: readonly string[], env: NodeJS.ProcessEnv): string[] => names.filter((n) => !env[n]?.trim());

function requireEnv(capability: string, names: readonly string[]): Record<string, string> {
  const missing = missingFrom(names, process.env);
  if (missing.length) throw new EvalServiceConfigError(capability, missing);
  return Object.fromEntries(names.map((n) => [n, process.env[n]!.trim()]));
}

function agentDirectory(): AgentDirectory {
  const entries = AgentRoleSchema.options.map((role) => {
    const raw = process.env[NAIVE_AGENT_ENV[role]]!.trim();
    const [agentId, version] = raw.split("@");
    const agentVersion = version ? Number(version) : undefined;
    if (!agentId || version === undefined || !(Number.isSafeInteger(agentVersion) && agentVersion! > 0)) {
      throw new EvalServiceConfigError("agents", [`${NAIVE_AGENT_ENV[role]} (expected <agentId>@<version>)`]);
    }
    return [role, { agentId, agentVersion }] as const;
  });
  return Object.fromEntries(entries) as AgentDirectory;
}

let pool: Pool | undefined;
/** One WebSocket pool per process: Track B ports need pinned-connection transactions (not Neon HTTP). */
function sqlPool(connectionString: string): Pool {
  pool ??= new Pool({ connectionString, max: 5 });
  return pool;
}

async function resolveJob(ctx: ServiceContext) {
  const [job] = await db().select({
    customerId: schema.jobs.customerId,
    package: schema.jobs.package,
    environment: schema.jobs.environment,
    retestOfJobId: schema.jobs.retestOfJobId,
  }).from(schema.jobs).where(eq(schema.jobs.id, ctx.jobId)).limit(1);
  if (!job) throw new Error("eval_job_not_found");
  if (job.environment !== ctx.environment) throw new Error("eval_job_environment_mismatch");
  return { customerId: job.customerId, package: job.package, isFixture: false, linkedRetestOf: job.retestOfJobId ?? null, quoteVersion: null };
}

export async function buildAgentDeps(): Promise<TrackBServiceDeps> {
  const env = requireEnv("agents", AGENT_ENV);
  const sql = pooledCalendarDatabase(sqlPool(env.DATABASE_URL));
  const client = createNaiveClient({ apiKey: env.NAIVE_API_KEY, baseUrl: process.env.NAIVE_BASE_URL || undefined });
  const configuredDirectory = agentDirectory();
  // Read-only attestation of exact configured versions. Never create/update agents from a request.
  const verified = await ensureAgents(client, { directory: configuredDirectory, dryRun: true });
  if (verified.missing.length || AgentRoleSchema.options.some(role => !verified.directory[role])) {
    throw new EvalServiceConfigError("agents", ["verified pinned Naive role versions"]);
  }
  const naive = createNaiveSessionsPort(client);
  const runner = new AgentSessionService({
    naive,
    store: new PostgresAgentTaskStore(sql),
    ledger: new PostgresBudgetLedger(sql),
    directory: verified.directory as AgentDirectory,
    budgetPeriodId: env.NAIVE_BUDGET_PERIOD_ID,
    idempotencyNamespace: env.NAIVE_IDEMPOTENCY_NAMESPACE,
    workerId: randomUUID(),
  });
  return { runner, resolveJob };
}

