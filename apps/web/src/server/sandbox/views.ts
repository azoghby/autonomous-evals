/** Store rows -> UI/MCP view-models (pure; no I/O). */
import type { CheckResult, EnvironmentSpec, EvalVersions, ScenarioResult } from "@ae/core/sandbox/spec";
import { SANDBOX_SPEC_VERSION } from "@ae/core/sandbox/spec";
import type { EnvironmentSummary, FailureCluster, SandboxDraft, SandboxRunReport, Severity, SuiteStatus } from "@/components/sandbox/contract";
import { envSpec, runResults, runScenarios, suiteScenarios, type EnvironmentRow, type RunRow, type SuiteRow } from "./store";

export function environmentSummary(env: EnvironmentSpec): EnvironmentSummary {
  return {
    tools: env.tools.map((t) => ({ name: t.name, description: t.description, effect: t.effect, source: t.source })),
    tables: env.state.reportTables,
    policies: env.policies,
    workflows: env.workflows,
  };
}

export function draftView(suite: SuiteRow, envRow: EnvironmentRow): SandboxDraft {
  const env = envSpec(envRow);
  return {
    draftId: suite.id,
    environmentId: envRow.id,
    name: envRow.name,
    domain: envRow.domain,
    mode: env.integration.mode,
    createdAt: suite.createdAt.toISOString(),
    sample: false,
    status: suite.status as SuiteStatus,
    ...(suite.error ? { error: suite.error } : {}),
    costMicroUsd: suite.costMicroUsd,
    environment: environmentSummary(env),
    scenarios: suiteScenarios(suite),
  };
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Groups failed (counted) trials by attribution + first failed check into report clusters. */
export function failureClusters(results: readonly ScenarioResult[]): FailureCluster[] {
  const groups = new Map<string, { cluster: FailureCluster; scenarios: Set<string> }>();
  for (const r of results) {
    for (const t of r.trials) {
      if (t.passed || t.failureAttribution === "simulator" || t.failureAttribution === "environment") continue;
      const failed: CheckResult[] = t.checks.filter((c) => !c.passed).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
      const top = failed[0];
      const attribution = t.failureAttribution ?? "unknown";
      const key = `${attribution}:${top?.id ?? t.error ?? "unknown"}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          cluster: {
            id: `cl_${groups.size + 1}`,
            title: top ? `${top.kind} check failed: ${top.id}` : `Trial error: ${t.error ?? "unknown"}`,
            rootCause: top?.detail ?? t.error ?? "No failed check recorded.",
            attribution,
            severity: top?.severity ?? "medium",
            ...(top?.policyRef ? { policyRef: top.policyRef } : {}),
            scenarioIds: [],
            trialCount: 0,
          },
          scenarios: new Set(),
        };
        groups.set(key, g);
      }
      g.cluster.trialCount++;
      g.scenarios.add(r.scenarioId);
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g.cluster, scenarioIds: [...g.scenarios] }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.trialCount - a.trialCount);
}

const PENDING_VERSIONS: EvalVersions = { spec: SANDBOX_SPEC_VERSION, suiteHash: "pending", simulatorModel: "pending", judgeModel: "pending", envHash: "pending", runtime: "pending" };

export function runReportView(run: RunRow, envRow: EnvironmentRow): SandboxRunReport {
  const env = envSpec(envRow);
  const scenarios = runScenarios(run);
  const results = runResults(run);
  return {
    runId: run.id,
    draftId: run.suiteId,
    name: envRow.name,
    domain: envRow.domain,
    mode: env.integration.mode,
    status: run.status as SandboxRunReport["status"],
    sample: false,
    createdAt: run.createdAt.toISOString(),
    ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    k: run.k,
    versions: (run.versions as EvalVersions | null) ?? PENDING_VERSIONS,
    scenarios,
    workflows: env.workflows.filter((w) => scenarios.some((s) => s.workflowId === w.id)),
    policies: env.policies,
    results,
    clusters: failureClusters(results),
    verifiedFix: null,
    media: [],
    ...(run.error ? { error: run.error } : {}),
    ...(run.errorKind ? { errorKind: run.errorKind as NonNullable<SandboxRunReport["errorKind"]> } : {}),
    costMicroUsd: run.costMicroUsd,
    budgetMicroUsd: run.budgetMicroUsd,
    progress: { trialsDone: run.trialsDone, trialsTotal: run.trialsTotal },
  };
}
