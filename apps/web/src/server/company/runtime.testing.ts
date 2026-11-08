/** In-memory RuntimeDeps for tests. Not imported by production code. */
import type { CompanyAgentId } from "@ae/core/company/registry";
import type { ActivityFinish, RunTrigger, RuntimeDeps } from "./runtime";

export interface MemoryActivity extends Omit<Partial<ActivityFinish>, "status"> {
  id: string; agentId: CompanyAgentId; trigger: RunTrigger; budgetMicroUsd: number; dryRun: boolean; startedAt: Date; status: string;
}

export interface MemoryRuntime {
  deps: RuntimeDeps;
  activities: MemoryActivity[];
  costs: Array<{ agent: string; source: string; microUsd: number; meta: Record<string, unknown> }>;
  toggles: Map<CompanyAgentId, boolean>;
  held: Set<string>;
}

export function memoryRuntime(opts: { spentToday?: number } = {}): MemoryRuntime {
  const activities: MemoryActivity[] = [];
  const costs: MemoryRuntime["costs"] = [];
  const toggles = new Map<CompanyAgentId, boolean>();
  const held = new Set<string>();
  let n = 0;
  const deps: RuntimeDeps = {
    getToggle: async (agent) => toggles.get(agent) ?? null,
    spentTodayMicroUsd: async () => (opts.spentToday ?? 0) + costs.reduce((s, c) => s + c.microUsd, 0),
    async withLock(key, fn) {
      const k = key.toString();
      if (held.has(k)) return { locked: true };
      held.add(k);
      try { return { locked: false, value: await fn() }; } finally { held.delete(k); }
    },
    async insertActivity(r) {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      activities.push({ id, ...r, status: "running" });
      return id;
    },
    async finishActivity(id, f) {
      const i = activities.findIndex((x) => x.id === id);
      if (i >= 0) activities[i] = { ...activities[i], ...f };
    },
    async insertCost(r) { costs.push(r); },
  };
  return { deps, activities, costs, toggles, held };
}
