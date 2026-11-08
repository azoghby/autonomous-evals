/**
 * Scenario quality gates (plan §8): oracle gate, null-agent gates, grader mutation test.
 * Grading here is deterministic only (no judge): a gate verdict must never depend on an LLM opinion.
 */
import type { EnvironmentSpec, SandboxRun, SandboxRuntime, SandboxScenario, StateDiff, TrialResult } from "../spec";
import { NULL_AGENTS, oracleAgent } from "./agents";
import { runEpisode } from "./episode";
import { gradeTrial } from "./graders";
import { scriptedSimulator } from "./simulator";
import type { AgentFactory, EngineDeps, GeneratedScenario, MutationKind, SimulatorFactory, TranscriptEntry } from "./types";
import { isMutableRun } from "./types";
import { clip, mapPool, tablesInDdl } from "./util";

export type GateMutationKind = MutationKind | "strip_outputs" | "strip_refusal" | "collateral_diff";
export interface MutationOutcome {
  id: string;
  kind: GateMutationKind;
  /** true = verdict flipped (good); false = grader missed it (reject); null = could not be tested. */
  flipped: boolean | null;
  detail: string;
}
export interface GateReport {
  scenarioId: string;
  accepted: boolean;
  reasons: string[];
  oracle: { passed: boolean; failedChecks: string[]; error?: string; transcript: TranscriptEntry[] };
  nullAgents: Array<{ agent: string; passed: boolean }>;
  mutations: MutationOutcome[];
  costMicroUsd: number;
}
export interface GateOptions {
  oracle?: AgentFactory;
  nullAgents?: readonly AgentFactory[];
  /** Simulator for the oracle (default: scripted, 2 turns: the oracle already knows everything). */
  oracleSimulator?: SimulatorFactory;
  /** Simulator for null agents (default: scripted, 3 turns). */
  nullSimulator?: SimulatorFactory;
  /** Reject when no SQL mutation could be tested (e.g. runtime without exec). Default false. */
  requireSqlMutations?: boolean;
}

/** Trial numbers reserved for gate runs so they never collide with suite trials. */
const ORACLE_TRIAL = 9_000;
const NULL_TRIAL = 9_100;
const REPLAY_TRIAL = 9_200;

const failedIds = (checks: Array<{ id: string; passed: boolean }>) => checks.filter((c) => !c.passed).map((c) => c.id);

async function disposeQuietly(run: SandboxRun | undefined): Promise<void> {
  try { await run?.dispose(); } catch { /* best effort */ }
}

/** Wraps a run so diff() reports an extra write to `table` (diff-level collateral mutation, no SQL needed). */
function withFakeCollateral(run: SandboxRun, table: string): SandboxRun {
  return {
    runId: `${run.runId}+collateral`,
    callTool: (n, a) => run.callTool(n, a),
    query: (s) => run.query(s),
    diff: async (): Promise<StateDiff[]> => [...(await run.diff()), { table, inserted: 0, updated: 1, deleted: 0, sample: [{ mutation: "collateral_diff" }] }],
    outbox: () => run.outbox(),
    trajectory: () => run.trajectory(),
    dispose: () => run.dispose(),
  };
}

function stripOutputs(transcript: TranscriptEntry[], scenario: SandboxScenario): TranscriptEntry[] {
  const needles = scenario.requiredOutputs.flatMap((r) => r.mustMention.map((m) => m.toLowerCase()));
  return transcript.map((t) => {
    if (t.role !== "assistant") return t;
    const lower = t.content.toLowerCase();
    return needles.some((n) => lower.includes(n.replace(/^\$/, ""))) ? { ...t, content: "[removed by mutation]" } : t;
  });
}
const stripRefusal = (transcript: TranscriptEntry[]): TranscriptEntry[] =>
  transcript.map((t) => (t.role === "assistant" ? { ...t, content: "Okay, noted." } : t));

function collateralProbeTable(env: EnvironmentSpec, scenario: SandboxScenario): string {
  const allowed = new Set([...scenario.allowedWriteTables, ...scenario.allowedChanges.map((c) => c.table)]);
  return tablesInDdl(env.state.ddl).find((t) => !allowed.has(t) && !t.startsWith("sandbox_")) ?? "mutation_probe";
}

async function sqlMutations(
  env: EnvironmentSpec, gen: GeneratedScenario, runtime: SandboxRuntime, worldId: string,
  oracleCalls: TrialResult["toolCalls"], transcript: TranscriptEntry[],
): Promise<MutationOutcome[]> {
  const { scenario } = gen;
  if (gen.mutations.length === 0) return [];
  const replay = async (trial: number): Promise<SandboxRun> => {
    const run = await runtime.startRun(worldId, env, scenario, trial);
    for (const c of oracleCalls) await run.callTool(c.tool, c.args);
    return run;
  };
  // Control: the unmutated replay must still pass, otherwise replay is not faithful and mutations prove nothing.
  let control: SandboxRun | undefined;
  try {
    control = await replay(REPLAY_TRIAL);
    if (!isMutableRun(control)) {
      return gen.mutations.map((m) => ({ id: m.id, kind: m.kind, flipped: null, detail: "runtime has no exec(): SQL mutation not testable" }));
    }
    const g = await gradeTrial({ env, scenario, run: control, transcript });
    if (!g.passed) {
      return gen.mutations.map((m) => ({ id: m.id, kind: m.kind, flipped: null, detail: `replay control failed (${failedIds(g.checks).join(", ")})` }));
    }
  } catch (e) {
    return gen.mutations.map((m) => ({ id: m.id, kind: m.kind, flipped: null, detail: `replay error: ${clip(String(e), 200)}` }));
  } finally {
    await disposeQuietly(control);
  }
  const out: MutationOutcome[] = [];
  for (const [i, m] of gen.mutations.entries()) {
    let run: SandboxRun | undefined;
    try {
      run = await replay(REPLAY_TRIAL + 1 + i);
      if (!isMutableRun(run)) { out.push({ id: m.id, kind: m.kind, flipped: null, detail: "runtime has no exec()" }); continue; }
      try { await run.exec(m.sql); } catch (e) {
        out.push({ id: m.id, kind: m.kind, flipped: null, detail: `mutation sql error: ${clip(e instanceof Error ? e.message : String(e), 200)}` });
        continue;
      }
      const g = await gradeTrial({ env, scenario, run, transcript });
      out.push({ id: m.id, kind: m.kind, flipped: !g.passed, detail: g.passed ? "graders still pass on mutated state" : `caught by ${failedIds(g.checks).join(", ")}` });
    } catch (e) {
      out.push({ id: m.id, kind: m.kind, flipped: null, detail: `replay error: ${clip(String(e), 200)}` });
    } finally {
      await disposeQuietly(run);
    }
  }
  return out;
}

/** Runs all automatic gates for one generated scenario against an already-prepared world. */
export async function runGates(
  env: EnvironmentSpec, gen: GeneratedScenario, runtime: SandboxRuntime, worldId: string, deps: EngineDeps, opts: GateOptions = {},
): Promise<{ scenario: SandboxScenario; report: GateReport }> {
  const { scenario } = gen;
  const reasons: string[] = [];
  let cost = 0;
  const report = (accepted: boolean, partial: Partial<GateReport>): { scenario: SandboxScenario; report: GateReport } => ({
    scenario: { ...scenario, oracleValidated: partial.oracle?.passed ?? false },
    report: {
      scenarioId: scenario.id, accepted, reasons,
      oracle: partial.oracle ?? { passed: false, failedChecks: [], transcript: [] },
      nullAgents: partial.nullAgents ?? [], mutations: partial.mutations ?? [], costMicroUsd: cost,
    },
  });

  // 1. Oracle gate.
  const oracle = opts.oracle ?? oracleAgent(deps);
  let oracleRun: SandboxRun | undefined;
  try {
    oracleRun = await runtime.startRun(worldId, env, scenario, ORACLE_TRIAL);
    const ep = await runEpisode({ env, scenario, run: oracleRun, agent: oracle, simulator: opts.oracleSimulator ?? scriptedSimulator({ maxTurns: 2 }), trial: ORACLE_TRIAL });
    cost += ep.costMicroUsd;
    const g = await gradeTrial({ env, scenario, run: oracleRun, transcript: ep.transcript });
    const oracleRes = { passed: g.passed && !ep.error, failedChecks: failedIds(g.checks), transcript: ep.transcript, ...(ep.error ? { error: ep.error } : {}) };
    if (!oracleRes.passed) {
      reasons.push(ep.error ? `oracle error: ${ep.error}` : `oracle failed: ${oracleRes.failedChecks.join(", ")}`);
      return report(false, { oracle: oracleRes });
    }

    // 2. Null-agent gates (cheap, deterministic): each must FAIL.
    const nulls = await mapPool(opts.nullAgents ?? NULL_AGENTS, 1, async (agent, i) => {
      let run: SandboxRun | undefined;
      try {
        run = await runtime.startRun(worldId, env, scenario, NULL_TRIAL + i);
        const nep = await runEpisode({ env, scenario, run, agent, simulator: opts.nullSimulator ?? scriptedSimulator({ maxTurns: 3 }), trial: NULL_TRIAL + i });
        const ng = await gradeTrial({ env, scenario, run, transcript: nep.transcript });
        return { agent: agent.name, passed: ng.passed };
      } finally {
        await disposeQuietly(run);
      }
    });
    for (const n of nulls) if (n.passed) reasons.push(`null agent passed: ${n.agent}`);

    // 3. Grader mutation test on the oracle's final state.
    const mutations: MutationOutcome[] = [];
    const flipCheck = async (id: string, kind: GateMutationKind, run: SandboxRun, transcript: TranscriptEntry[]) => {
      const mg = await gradeTrial({ env, scenario, run, transcript });
      mutations.push({ id, kind, flipped: !mg.passed, detail: mg.passed ? "graders still pass on mutated outcome" : `caught by ${failedIds(mg.checks).join(", ")}` });
    };
    if (scenario.requiredOutputs.length) await flipCheck("t_outputs", "strip_outputs", oracleRun, stripOutputs(ep.transcript, scenario));
    if (scenario.expectRefusal) await flipCheck("t_refusal", "strip_refusal", oracleRun, stripRefusal(ep.transcript));
    await flipCheck("d_collateral", "collateral_diff", withFakeCollateral(oracleRun, collateralProbeTable(env, scenario)), ep.transcript);
    mutations.push(...(await sqlMutations(env, gen, runtime, worldId, oracleRun.trajectory(), ep.transcript)));

    for (const m of mutations) if (m.flipped === false) reasons.push(`weak grader: mutation ${m.id} (${m.kind}) not detected`);
    const sqlTested = mutations.some((m) => ["drop_expected", "collateral", "change_amount"].includes(m.kind) && m.flipped !== null);
    if (opts.requireSqlMutations && !sqlTested) reasons.push("no SQL mutation could be tested");
    return report(reasons.length === 0, { oracle: oracleRes, nullAgents: nulls, mutations });
  } catch (e) {
    reasons.push(`gate error: ${clip(e instanceof Error ? e.message : String(e), 300)}`);
    return report(false, {});
  } finally {
    await disposeQuietly(oracleRun);
  }
}

/** Gates a whole generated suite on its own prepared world. Returns accepted scenarios (oracleValidated=true) + reports. */
export async function gateSuite(
  env: EnvironmentSpec, generated: readonly GeneratedScenario[], runtime: SandboxRuntime, deps: EngineDeps,
  opts: GateOptions & { jobId: string; concurrency?: number },
): Promise<{ accepted: SandboxScenario[]; reports: GateReport[] }> {
  const { worldId } = await runtime.prepare(env, opts.jobId);
  try {
    const results = await mapPool(generated, opts.concurrency ?? 2, (g) => runGates(env, g, runtime, worldId, deps, opts));
    return {
      accepted: results.filter((r) => r.report.accepted).map((r) => ({ ...r.scenario, oracleValidated: true })),
      reports: results.map((r) => r.report),
    };
  } finally {
    await runtime.teardown(worldId);
  }
}
