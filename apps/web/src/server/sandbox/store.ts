import "server-only";
/**
 * Sandbox Evals persistence (sandbox_environments / sandbox_suites / sandbox_runs). Owner-scoped reads return null
 * for rows that belong to someone else, so ids are not probeable. *ById variants are for workflow steps only.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { GatewayContext } from "@ae/core/ai/gateway";
import type { EnvironmentSpec, SandboxScenario, ScenarioResult } from "@ae/core/sandbox/spec";
import type { DraftScenario, SuiteStatus } from "@/components/sandbox/contract";

export type EnvironmentRow = typeof schema.sandboxEnvironments.$inferSelect;
export type SuiteRow = typeof schema.sandboxSuites.$inferSelect;
export type RunRow = typeof schema.sandboxRuns.$inferSelect;
export type RunStatus = "queued" | "running" | "complete" | "failed";

export const envSpec = (row: EnvironmentRow): EnvironmentSpec => row.spec as EnvironmentSpec;
export const suiteScenarios = (row: SuiteRow): DraftScenario[] => row.scenarios as DraftScenario[];
export const runScenarios = (row: RunRow): SandboxScenario[] => row.scenarios as SandboxScenario[];
export const runResults = (row: RunRow): ScenarioResult[] => row.results as ScenarioResult[];

export interface RunListItem {
  runId: string; name: string; status: RunStatus; k: number; scenarios: number; passAt1: number | null; passHatK: number | null;
  costMicroUsd: number; createdAt: string; completedAt: string | null;
}

/** The store surface the service and workflow steps use (tests pass an in-memory fake). */
export interface SandboxStore {
  insertEnvironment(row: typeof schema.sandboxEnvironments.$inferInsert): Promise<EnvironmentRow>;
  getEnvironment(ownerId: string, id: string): Promise<EnvironmentRow | null>;
  getEnvironmentById(id: string): Promise<EnvironmentRow | null>;
  insertSuite(row: typeof schema.sandboxSuites.$inferInsert): Promise<SuiteRow>;
  getSuite(ownerId: string, id: string): Promise<SuiteRow | null>;
  getSuiteById(id: string): Promise<SuiteRow | null>;
  updateSuite(id: string, patch: Partial<Pick<SuiteRow, "status" | "generated" | "scenarios" | "error" | "workflowRunId">>): Promise<void>;
  insertRun(row: typeof schema.sandboxRuns.$inferInsert): Promise<RunRow>;
  getRun(ownerId: string, id: string): Promise<RunRow | null>;
  getRunById(id: string): Promise<RunRow | null>;
  /** Owner's newest runs with their environment name (dashboard list). */
  listRuns(ownerId: string, limit: number): Promise<RunListItem[]>;
  updateRun(id: string, patch: Partial<Omit<RunRow, "id" | "ownerId" | "createdAt">>): Promise<void>;
  /** Replaces (or appends) the result for result.scenarioId. Idempotent under step retries. */
  putRunResult(id: string, result: ScenarioResult): Promise<void>;
  incrementTrials(id: string, by?: number): Promise<void>;
  /** Active (not finished) suites + runs for an owner: the per-owner concurrency cap. */
  countActive(ownerId: string): Promise<{ suites: number; runs: number }>;
  /** Environments the owner currently has (plan limit). */
  countEnvironments(ownerId: string): Promise<number>;
  /**
   * Usage since `since` (plan window): trials = trials reserved by runs created in the window (a run that failed
   * before finishing counts only the trials it actually ran), costMicroUsd = our spend on suites + runs in the window.
   */
  usageSince(ownerId: string, since: Date): Promise<{ trials: number; costMicroUsd: number }>;
  /** Records one cost row (costs table, job_id null) and adds it to the suite/run total. */
  addCost(target: { kind: "suite" | "run"; id: string }, entry: Parameters<GatewayContext["recordCost"]>[0]): Promise<void>;
}

const one = <T>(rows: T[]): T | null => rows[0] ?? null;
const now = () => new Date();

export function createDbSandboxStore(): SandboxStore {
  const E = schema.sandboxEnvironments, S = schema.sandboxSuites, R = schema.sandboxRuns;
  return {
    async insertEnvironment(row) { return (await db().insert(E).values(row).returning())[0]!; },
    async getEnvironment(ownerId, id) { return one(await db().select().from(E).where(and(eq(E.id, id), eq(E.ownerId, ownerId))).limit(1)); },
    async getEnvironmentById(id) { return one(await db().select().from(E).where(eq(E.id, id)).limit(1)); },
    async insertSuite(row) { return (await db().insert(S).values(row).returning())[0]!; },
    async getSuite(ownerId, id) { return one(await db().select().from(S).where(and(eq(S.id, id), eq(S.ownerId, ownerId))).limit(1)); },
    async getSuiteById(id) { return one(await db().select().from(S).where(eq(S.id, id)).limit(1)); },
    async updateSuite(id, patch) { await db().update(S).set({ ...patch, updatedAt: now() }).where(eq(S.id, id)); },
    async insertRun(row) { return (await db().insert(R).values(row).returning())[0]!; },
    async getRun(ownerId, id) { return one(await db().select().from(R).where(and(eq(R.id, id), eq(R.ownerId, ownerId))).limit(1)); },
    async getRunById(id) { return one(await db().select().from(R).where(eq(R.id, id)).limit(1)); },
    async listRuns(ownerId, limit) {
      const rows = await db().select({
        id: R.id, name: E.name, status: R.status, k: R.k, scenarios: sql<number>`jsonb_array_length(${R.scenarios})::int`, passAt1: R.passAt1, passHatK: R.passHatK,
        costMicroUsd: R.costMicroUsd, createdAt: R.createdAt, completedAt: R.completedAt,
      }).from(R).innerJoin(E, eq(E.id, R.environmentId)).where(eq(R.ownerId, ownerId)).orderBy(desc(R.createdAt)).limit(limit);
      return rows.map((r) => ({
        runId: r.id, name: r.name, status: r.status as RunStatus, k: r.k, scenarios: Number(r.scenarios), passAt1: r.passAt1, passHatK: r.passHatK,
        costMicroUsd: r.costMicroUsd, createdAt: new Date(r.createdAt).toISOString(), completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
      }));
    },
    async updateRun(id, patch) { await db().update(R).set({ ...patch, updatedAt: now() }).where(eq(R.id, id)); },
    async putRunResult(id, result) {
      const json = JSON.stringify(result);
      await db().update(R).set({
        results: sql`(select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(${R.results}) e where e->>'scenarioId' <> ${result.scenarioId}) || jsonb_build_array(${json}::jsonb)`,
        updatedAt: now(),
      }).where(eq(R.id, id));
    },
    async incrementTrials(id, by = 1) {
      await db().update(R).set({ trialsDone: sql`least(${R.trialsDone} + ${by}, ${R.trialsTotal})`, updatedAt: now() }).where(eq(R.id, id));
    },
    async countActive(ownerId) {
      const active: SuiteStatus[] = ["generating", "gating"];
      const [s] = await db().select({ n: sql<number>`count(*)::int` }).from(S).where(and(eq(S.ownerId, ownerId), inArray(S.status, active)));
      const [r] = await db().select({ n: sql<number>`count(*)::int` }).from(R).where(and(eq(R.ownerId, ownerId), inArray(R.status, ["queued", "running"])));
      return { suites: s?.n ?? 0, runs: r?.n ?? 0 };
    },
    async countEnvironments(ownerId) {
      const [e] = await db().select({ n: sql<number>`count(*)::int` }).from(E).where(eq(E.ownerId, ownerId));
      return e?.n ?? 0;
    },
    async usageSince(ownerId, since) {
      const [r] = await db().select({
        trials: sql<number>`coalesce(sum(case when ${R.status} = 'failed' then ${R.trialsDone} else ${R.trialsTotal} end), 0)::int`,
        cost: sql<number>`coalesce(sum(${R.costMicroUsd}), 0)::bigint`,
      }).from(R).where(and(eq(R.ownerId, ownerId), gte(R.createdAt, since)));
      const [s] = await db().select({ cost: sql<number>`coalesce(sum(${S.costMicroUsd}), 0)::bigint` })
        .from(S).where(and(eq(S.ownerId, ownerId), gte(S.createdAt, since)));
      return { trials: Number(r?.trials ?? 0), costMicroUsd: Number(r?.cost ?? 0) + Number(s?.cost ?? 0) };
    },
    async addCost(target, entry) {
      const meta = { ...(entry.meta ?? {}), [target.kind === "run" ? "sandboxRunId" : "sandboxSuiteId"]: target.id };
      await db().insert(schema.costs).values({ jobId: null, source: entry.source, agent: entry.agent ?? null, sessionId: entry.sessionId ?? null, microUsd: entry.microUsd, meta });
      const table = target.kind === "run" ? R : S;
      await db().update(table).set({ costMicroUsd: sql`${table.costMicroUsd} + ${entry.microUsd}` }).where(eq(table.id, target.id));
    },
  };
}

/**
 * Budget-capped GatewayContext for one workflow step: remaining = cap - (already spent by earlier steps) - (this step).
 * Every cost is persisted immediately, so a retried step sees what the failed attempt spent.
 */
export function stepBudgetContext(
  store: Pick<SandboxStore, "addCost">, target: { kind: "suite" | "run"; id: string }, capMicroUsd: number, spentBeforeMicroUsd: number,
): GatewayContext & { readonly budgetMicroUsd: number; spentMicroUsd(): number } {
  let spent = 0;
  return {
    get budgetMicroUsd() { return Math.max(0, capMicroUsd - spentBeforeMicroUsd - spent); },
    async recordCost(entry) {
      spent += entry.microUsd;
      await store.addCost(target, entry);
    },
    spentMicroUsd: () => spent,
  };
}
