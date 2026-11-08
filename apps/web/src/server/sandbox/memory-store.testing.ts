/** In-memory SandboxStore for unit tests (no DB). Mirrors the owner scoping and idempotent putRunResult of the DB store. */
import type { EnvironmentRow, RunRow, SandboxStore, SuiteRow } from "./store";

export const OWNER_A = "00000000-0000-4000-8000-00000000000a";
export const OWNER_B = "00000000-0000-4000-8000-00000000000b";

export function createMemoryStore() {
  const envs = new Map<string, EnvironmentRow>();
  const suites = new Map<string, SuiteRow>();
  const runs = new Map<string, RunRow>();
  const costs: Array<{ kind: "suite" | "run"; id: string; microUsd: number }> = [];
  const t0 = new Date("2026-06-01T00:00:00Z");

  let lockChain: Promise<unknown> = Promise.resolve();
  const store: SandboxStore = {
    /** Serializes like the DB's per-owner advisory lock (one global chain is enough for tests). */
    withOwnerLock(_ownerId, fn) {
      const next = lockChain.then(() => fn(store));
      lockChain = next.catch(() => undefined);
      return next;
    },
    async insertEnvironment(row) {
      const r = { orgId: null, prebuiltId: null, warnings: [], createdAt: t0, updatedAt: t0, ...row } as EnvironmentRow;
      envs.set(r.id, r);
      return r;
    },
    async getEnvironment(ownerId, id) { const r = envs.get(id); return r && r.ownerId === ownerId ? r : null; },
    async getEnvironmentById(id) { return envs.get(id) ?? null; },
    async insertSuite(row) {
      const r = { orgId: null, generated: [], scenarios: [], costMicroUsd: 0, error: null, workflowRunId: null, createdAt: t0, updatedAt: t0, ...row } as SuiteRow;
      suites.set(r.id, r);
      return r;
    },
    async getSuite(ownerId, id) { const r = suites.get(id); return r && r.ownerId === ownerId ? r : null; },
    async getSuiteById(id) { return suites.get(id) ?? null; },
    async updateSuite(id, patch) { const r = suites.get(id); if (r) suites.set(id, { ...r, ...patch }); },
    async insertRun(row) {
      const r = {
        orgId: null, suiteId: null, results: [], gates: [], summary: null, passAt1: null, passHatK: null, ci95Low: null, ci95High: null, versions: null,
        costMicroUsd: 0, trialsDone: 0, trialsTotal: 0, worldId: null, workflowRunId: null, error: null, errorKind: null, startedAt: null, completedAt: null,
        createdAt: t0, updatedAt: t0, ...row,
      } as RunRow;
      runs.set(r.id, r);
      return r;
    },
    async getRun(ownerId, id) { const r = runs.get(id); return r && r.ownerId === ownerId ? r : null; },
    async getRunById(id) { return runs.get(id) ?? null; },
    async listRuns(ownerId, limit) {
      return [...runs.values()].filter((r) => r.ownerId === ownerId)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, limit)
        .map((r) => ({
          runId: r.id, name: envs.get(r.environmentId)?.name ?? "Environment", status: r.status as never, k: r.k,
          scenarios: Array.isArray(r.scenarios) ? r.scenarios.length : 0, passAt1: r.passAt1 ?? null, passHatK: r.passHatK ?? null,
          costMicroUsd: r.costMicroUsd ?? 0, createdAt: new Date(r.createdAt ?? Date.now()).toISOString(),
          completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
        }));
    },
    async updateRun(id, patch) { const r = runs.get(id); if (r) runs.set(id, { ...r, ...patch } as RunRow); },
    async putRunResult(id, result) {
      const r = runs.get(id);
      if (!r) return;
      const rest = (r.results as Array<{ scenarioId: string }>).filter((x) => x.scenarioId !== result.scenarioId);
      runs.set(id, { ...r, results: [...rest, result] });
    },
    async incrementTrials(id, by = 1) {
      const r = runs.get(id);
      if (r) runs.set(id, { ...r, trialsDone: Math.min(r.trialsDone + by, r.trialsTotal) });
    },
    async countActive(ownerId) {
      return {
        suites: [...suites.values()].filter((s) => s.ownerId === ownerId && (s.status === "generating" || s.status === "gating")).length,
        runs: [...runs.values()].filter((r) => r.ownerId === ownerId && (r.status === "queued" || r.status === "running")).length,
      };
    },
    async countEnvironments(ownerId) { return [...envs.values()].filter((e) => e.ownerId === ownerId).length; },
    async usageSince(ownerId, since) {
      const inWindow = <T extends { ownerId: string; createdAt: Date }>(r: T) => r.ownerId === ownerId && r.createdAt >= since;
      const rs = [...runs.values()].filter(inWindow);
      const trials = rs.reduce((n, r) => n + (r.status === "failed" ? r.trialsDone : r.trialsTotal), 0);
      const cost = rs.reduce((n, r) => n + r.costMicroUsd, 0) + [...suites.values()].filter(inWindow).reduce((n, s) => n + s.costMicroUsd, 0);
      const reserved = [...runs.values()].filter((r) => r.ownerId === ownerId && (r.status === "queued" || r.status === "running")).reduce((n, r) => n + Math.max(0, r.budgetMicroUsd - r.costMicroUsd), 0)
        + [...suites.values()].filter((s) => s.ownerId === ownerId && (s.status === "generating" || s.status === "gating")).reduce((n, s) => n + Math.max(0, s.budgetMicroUsd - s.costMicroUsd), 0);
      return { trials, costMicroUsd: cost, reservedMicroUsd: reserved };
    },
    async addCost(target, entry) {
      costs.push({ ...target, microUsd: entry.microUsd });
      if (target.kind === "run") { const r = runs.get(target.id); if (r) runs.set(r.id, { ...r, costMicroUsd: r.costMicroUsd + entry.microUsd }); }
      else { const s = suites.get(target.id); if (s) suites.set(s.id, { ...s, costMicroUsd: s.costMicroUsd + entry.microUsd }); }
    },
  };
  return { store, envs, suites, runs, costs };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
