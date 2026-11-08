/**
 * Real `EvalServices` (EVAL_SERVICES=real), built from server environment on first use.
 * Importing this module has no side effects: no env reads, connections or network calls until a
 * method is invoked. Unconfigured capabilities throw `EvalServiceConfigError` naming the missing vars.
 *
 * Persistence prerequisites (NOT applied automatically; see docs/INTEGRATION.md "Track B migrations"):
 *   - agents/persistence-migrations/001-agent-persistence.sql   (agent task CAS + budget ledger)
 *   - simulator/ledger-migrations/001_branch_ownership.sql      (branch ownership ledger)
 */
import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import type { EvalServices, ServiceContext } from "../contracts/services";
import { db, schema } from "../db/client";
import { createNaiveClient, createNaiveSessionsPort } from "../agents/naive-adapter";
import { PostgresAgentTaskStore, PostgresBudgetLedger } from "../agents/postgres-ports";
import { AgentSessionService } from "../agents/session-service";
import { pooledCalendarDatabase } from "../simulator/pool";
import { PostgresBranchLedger } from "../simulator/branch-ledger";
import { NeonBranchService, NeonHttpApi } from "../simulator/neon";
import { createNeonConnectionResolver } from "../simulator/connection";
import { createBranchServices } from "../simulator/adapters";
import type { TrackBServiceDeps } from "../evals/service-adapter";
import { AgentRoleSchema, type AgentDirectory, type AgentRole } from "../evals/types";
import { composeEvalServices, type BranchServices } from "./compose";

export { composeEvalServices, EvalServiceUnavailableError } from "./compose";
export { TrackBBlockedError, TrackBPendingError } from "../evals/service-adapter";

export class EvalServiceConfigError extends Error {
  readonly retryable = false;
  constructor(readonly capability: string, readonly missing: string[]) {
    super(`EVAL_SERVICES=real: ${capability} is not configured; missing env: ${missing.join(", ")}`);
    this.name = "EvalServiceConfigError";
  }
}

/** Env var per Naïve agent role. Value: `<agentId>` or `<agentId>@<version>`. */
export const NAIVE_AGENT_ENV: Readonly<Record<AgentRole, string>> = {
  commercial: "NAIVE_AGENT_COMMERCIAL",
  evaluation_engineer: "NAIVE_AGENT_EVALUATION_ENGINEER",
  quality_investigator: "NAIVE_AGENT_QUALITY_INVESTIGATOR",
  company_operator: "NAIVE_AGENT_COMPANY_OPERATOR",
};

const AGENT_ENV = ["NAIVE_API_KEY", "DATABASE_URL", ...Object.values(NAIVE_AGENT_ENV)];
const BRANCH_ENV = ["NEON_API_KEY", "NEON_PROJECT_ID", "NEON_SIM_SEED_BRANCH_ID", "DATABASE_URL"];

const missingFrom = (names: readonly string[], env: NodeJS.ProcessEnv): string[] => names.filter((n) => !env[n]?.trim());

/** Which env vars each real capability still needs (names only; never values). */
export function missingRealServiceEnv(env: NodeJS.ProcessEnv = process.env): { agents: string[]; branches: string[] } {
  return { agents: missingFrom(AGENT_ENV, env), branches: missingFrom(BRANCH_ENV, env) };
}

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
    if (!agentId || (version !== undefined && !(Number.isSafeInteger(agentVersion) && agentVersion! > 0))) {
      throw new EvalServiceConfigError("agents", [`${NAIVE_AGENT_ENV[role]} (expected <agentId>[@<version>])`]);
    }
    return [role, { agentId, agentVersion }] as const;
  });
  return Object.fromEntries(entries) as AgentDirectory;
}

let pool: Pool | undefined;
/**
 * One WebSocket pool per process: Track B ports need pinned-connection transactions (not Neon HTTP).
 * Prefer the direct (unpooled) endpoint: the branch ledger holds a SESSION advisory lock across
 * statements, which PgBouncer transaction pooling (`-pooler` hosts) breaks: the unlock lands on a
 * different server connection and returns false (`branch_ledger_unlock_failed`).
 */
export function trackBDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DATABASE_URL_UNPOOLED?.trim() || env.DATABASE_URL?.trim() || undefined;
}
function sqlPool(): Pool {
  pool ??= new Pool({ connectionString: trackBDatabaseUrl(), max: 5 });
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

async function buildAgentDeps(): Promise<TrackBServiceDeps> {
  const env = requireEnv("agents", AGENT_ENV);
  const sql = pooledCalendarDatabase(sqlPool());
  const naive = createNaiveSessionsPort(createNaiveClient({ apiKey: env.NAIVE_API_KEY, baseUrl: process.env.NAIVE_BASE_URL || undefined }));
  const runner = new AgentSessionService({
    naive,
    store: new PostgresAgentTaskStore(sql),
    ledger: new PostgresBudgetLedger(sql),
    directory: agentDirectory(),
    budgetPeriodId: process.env.NAIVE_BUDGET_PERIOD_ID || new Date().toISOString().slice(0, 7),
    idempotencyNamespace: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    workerId: randomUUID(),
  });
  return { runner, resolveJob };
}

async function buildBranchServices(): Promise<BranchServices> {
  const env = requireEnv("branches", BRANCH_ENV);
  const ledger = new PostgresBranchLedger(sqlPool());
  const service = new NeonBranchService(new NeonHttpApi(env.NEON_API_KEY), ledger, env.NEON_PROJECT_ID, env.NEON_SIM_SEED_BRANCH_ID);
  const appUrl = new URL(env.DATABASE_URL);
  const findOwnedBranch = (branchId: string) => ledger.findOwnedBranch(branchId);
  const connectionString = createNeonConnectionResolver({
    projectId: env.NEON_PROJECT_ID,
    seedBranchId: env.NEON_SIM_SEED_BRANCH_ID,
    databaseName: process.env.NEON_SIM_DATABASE_NAME || decodeURIComponent(appUrl.pathname.slice(1)),
    roleName: process.env.NEON_SIM_ROLE_NAME || decodeURIComponent(appUrl.username),
    apiKey: env.NEON_API_KEY,
    findOwnedBranch,
  });
  return createBranchServices({ service, findOwnedBranch, connectionString });
}

/** Track A's `getEvalServices()` returns this when EVAL_SERVICES=real. */
export const evalServices: EvalServices = composeEvalServices({ agents: buildAgentDeps, branches: buildBranchServices });
