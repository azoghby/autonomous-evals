import { describe, expect, it } from "vitest";
import { SandboxScenario } from "../spec";
import { gateSuite, runGates, type GateOptions } from "./gates";
import { FakeRuntime, type FakeWorld } from "./testing/fake-runtime";
import { fakeGateway, memoryCtx } from "./testing/fake-gateway";
import { refundOracle, scriptedAgent } from "./testing/agents";
import { COLLATERAL_SQL, DROP_REFUND_SQL, NO_REFUND_SQL, TRIVIAL_SQL, miniEnv, miniWorld, refundMutations, refundScenario } from "./testing/fixtures";
import type { EngineDeps, GeneratedScenario } from "./types";

const IMPOSSIBLE_SQL = "SELECT EXISTS(SELECT 1 FROM refunds WHERE amount = 999) AS ok";
const world: FakeWorld = { ...miniWorld, queries: { ...miniWorld.queries, [IMPOSSIBLE_SQL]: (t) => [{ ok: t.refunds!.some((r) => r.amount === 999) }] } };
const deps = (): EngineDeps => ({ gateway: fakeGateway(() => { throw new Error("no LLM expected in gates with scripted oracle"); }), ctx: memoryCtx() });
const slot = { workflowId: "refund_request", category: "happy_path" as const, impossible: false, index: 0 };
const gen = (scenario: SandboxScenario, mutations = refundMutations): GeneratedScenario => ({ scenario, mutations, slot });

async function gate(scenario: SandboxScenario, opts: { mutations?: GeneratedScenario["mutations"]; oracle?: GateOptions; mutable?: boolean } = {}) {
  const rt = new FakeRuntime(world, { mutable: opts.mutable ?? true });
  const { worldId } = await rt.prepare(miniEnv, "job_gates");
  const res = await runGates(miniEnv, gen(scenario, opts.mutations), rt, worldId, deps(), { oracle: refundOracle, ...(opts.oracle ?? {}) });
  return { ...res, rt };
}

describe("gates", () => {
  it("accepts a solvable scenario: oracle passes, null agents fail, every mutation flips", async () => {
    const { scenario, report, rt } = await gate(refundScenario);
    expect(report.reasons).toEqual([]);
    expect(report.accepted).toBe(true);
    expect(scenario.oracleValidated).toBe(true);
    expect(report.nullAgents.map((n) => n.passed)).toEqual([false, false, false]);
    expect(report.mutations.map((m) => m.kind).sort()).toEqual(["change_amount", "collateral", "collateral_diff", "drop_expected", "strip_outputs"]);
    expect(report.mutations.every((m) => m.flipped === true)).toBe(true);
    expect(rt.runs.every((r) => r.disposed)).toBe(true);
  });

  it("rejects an unsolvable scenario (oracle cannot satisfy the assertions)", async () => {
    const unsolvable = SandboxScenario.parse({ ...refundScenario, id: "sx_unsolvable", stateAssertions: [{ id: "impossible", description: "refund of 999", sql: IMPOSSIBLE_SQL, severity: "critical" }] });
    const { scenario, report } = await gate(unsolvable);
    expect(report.accepted).toBe(false);
    expect(scenario.oracleValidated).toBe(false);
    expect(report.reasons[0]).toMatch(/oracle failed: .*assert:impossible/);
    expect(report.nullAgents).toEqual([]); // short-circuits: no spend on later gates
  });

  it("rejects a scenario a do-nothing agent passes", async () => {
    const idle = SandboxScenario.parse({
      ...refundScenario, id: "sx_idle_passes", title: "no refund expected", trajectoryAssertions: [], requiredOutputs: [], expectedChanges: [],
      stateAssertions: [{ id: "no_refund", description: "no refund", sql: NO_REFUND_SQL, severity: "high" }],
    });
    const idleOracle = scriptedAgent("test:idle_oracle", async () => "Sure.");
    const { report } = await gate(idle, { mutations: [], oracle: { oracle: idleOracle } });
    expect(report.accepted).toBe(false);
    expect(report.reasons).toContain("null agent passed: null:do_nothing");
  });

  it("mutation test catches a weak grader", async () => {
    const weak = SandboxScenario.parse({
      ...refundScenario, id: "sx_weak_grader", expectedChanges: [],
      stateAssertions: [{ id: "trivial", description: "always true", sql: TRIVIAL_SQL, severity: "critical" }],
    });
    const { report } = await gate(weak, { mutations: [{ id: "m_drop", kind: "drop_expected", sql: DROP_REFUND_SQL }] });
    expect(report.accepted).toBe(false);
    expect(report.mutations.find((m) => m.id === "m_drop")?.flipped).toBe(false);
    expect(report.reasons.some((r) => r.startsWith("weak grader: mutation m_drop"))).toBe(true);
    // collateral writes are still caught generically
    expect(report.mutations.find((m) => m.kind === "collateral_diff")?.flipped).toBe(true);
  });

  it("without exec() SQL mutations are reported untestable (accepted unless required)", async () => {
    const a = await gate(refundScenario, { mutable: false });
    expect(a.report.accepted).toBe(true);
    expect(a.report.mutations.filter((m) => m.flipped === null).map((m) => m.id).sort()).toEqual(["m_amount", "m_collateral", "m_drop"]);
    const rt = new FakeRuntime(world, { mutable: false });
    const { worldId } = await rt.prepare(miniEnv, "job_req");
    const b = await runGates(miniEnv, gen(refundScenario), rt, worldId, deps(), { oracle: refundOracle, requireSqlMutations: true });
    expect(b.report.reasons).toContain("no SQL mutation could be tested");
  });

  it("expectRefusal: idle agents fail, refusal-stripping mutation flips", async () => {
    const refusal = SandboxScenario.parse({
      ...refundScenario, id: "sx_refusal", expectRefusal: true, expectedChanges: [], allowedChanges: [], allowedWriteTables: [], requiredOutputs: [], trajectoryAssertions: [{ id: "no_refund", type: "not_called", tool: "refund_order", description: "no refund", severity: "critical" }],
      stateAssertions: [{ id: "no_refund_row", description: "no refund", sql: NO_REFUND_SQL, severity: "critical" }],
    });
    const refuser = scriptedAgent("test:refuser", async () => "I'm sorry, but I can't refund this order under our policy.");
    const { report } = await gate(refusal, { mutations: [{ id: "m_c", kind: "collateral", sql: COLLATERAL_SQL }], oracle: { oracle: refuser } });
    expect(report.reasons).toEqual([]);
    expect(report.nullAgents.every((n) => !n.passed)).toBe(true);
    expect(report.mutations.find((m) => m.kind === "strip_refusal")?.flipped).toBe(true);
  });

  it("gateSuite prepares once, tears down, and returns only accepted scenarios", async () => {
    const rt = new FakeRuntime(world);
    const weak = SandboxScenario.parse({ ...refundScenario, id: "sx_weak2", expectedChanges: [], stateAssertions: [] , trajectoryAssertions: [{ id: "c", type: "called", tool: "lookup_order", description: "looked up", severity: "high" }] });
    const out = await gateSuite(miniEnv, [gen(refundScenario), gen(weak)], rt, deps(), { jobId: "j1", oracle: refundOracle });
    expect(out.accepted.map((s) => s.id)).toEqual([refundScenario.id]);
    expect(out.accepted[0]!.oracleValidated).toBe(true);
    expect(rt.prepared).toEqual(["world_j1"]);
    expect(rt.tornDown).toEqual(["world_j1"]);
  });
});
