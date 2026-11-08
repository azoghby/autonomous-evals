import { describe, expect, it } from "vitest";
import { GatewayError } from "../../ai/gateway";
import { NULL_AGENTS, doNothingAgent, dumpEverythingAgent, emptyReplyAgent, oracleAgent, oracleSystemPrompt } from "./agents";
import { fakeGateway, memoryCtx } from "./testing/fake-gateway";
import { FakeRuntime } from "./testing/fake-runtime";
import { miniEnv, miniWorld, refundScenario } from "./testing/fixtures";
import type { EngineDeps } from "./types";

async function newRun() {
  const rt = new FakeRuntime(miniWorld);
  const { worldId } = await rt.prepare(miniEnv, "j1");
  return rt.startRun(worldId, miniEnv, refundScenario, 0);
}

describe("oracleAgent", () => {
  it("solves the refund scenario and records cost", async () => {
    const script = [
      { action: "tool", tool: "verify_identity", args: { customer_id: "c_1", email: "ann@example.com" } },
      { action: "tool", tool: "refund_order", args: { order_id: "o_100", amount: 47.2 } },
      { action: "reply", content: "Your refund of $47.20 has been issued." },
    ];
    let i = 0;
    const gateway = fakeGateway(() => script[i++]);
    const deps: EngineDeps = { gateway, ctx: memoryCtx() };
    const run = await newRun();
    const session = oracleAgent(deps).start({ env: miniEnv, scenario: refundScenario, run });
    const turn = await session.send("I want a refund for o_100");
    expect(turn.error).toBeUndefined();
    expect(turn.reply).toContain("47.20");
    expect(turn.costMicroUsd).toBe(300);
    expect(turn.transcript.map((e) => e.role)).toEqual(["tool", "tool", "assistant"]);
    expect(run.trajectory().map((r) => r.tool)).toEqual(["verify_identity", "refund_order"]);
    expect(await run.query(refundScenario.stateAssertions[0]!.sql)).toEqual([{ ok: true }]);
    expect(gateway.calls[0]).toMatchObject({ agent: "operator", temperature: 0 });
    expect(gateway.calls[1]!.prompt).toContain("verify_identity");
  });

  it("system prompt carries the privileged context", () => {
    const sp = oracleSystemPrompt(miniEnv, { ...refundScenario, expectRefusal: true });
    for (const s of ["refund_order", "Refunds are allowed within 30 days", "CREATE TABLE refunds", "INSERT INTO customers", refundScenario.stateAssertions[0]!.sql, "47.20", "My email is ann@example.com", "I'm sorry, but I can't", "Allowed write tables"]) {
      expect(sp).toContain(s);
    }
  });

  it("maps gateway errors", async () => {
    const gateway = fakeGateway(() => { throw new GatewayError("all_providers_failed", "down"); });
    const session = oracleAgent({ gateway, ctx: memoryCtx() }).start({ env: miniEnv, scenario: refundScenario, run: await newRun() });
    expect((await session.send("hi")).error).toBe("oracle_error: all_providers_failed");
  });

  it("enforces the step limit", async () => {
    const gateway = fakeGateway(() => ({ action: "tool", tool: "lookup_order", args: { order_id: "o_100" } }));
    const session = oracleAgent({ gateway, ctx: memoryCtx() }, { maxStepsPerTurn: 2 }).start({ env: miniEnv, scenario: refundScenario, run: await newRun() });
    const turn = await session.send("hi");
    expect(turn.error).toBe("oracle_error: step_limit");
    expect(turn.costMicroUsd).toBe(200);
  });
});

describe("null agents", () => {
  it("lists all three", () => {
    expect(NULL_AGENTS.map((a) => a.name)).toEqual(["null:do_nothing", "null:empty_reply", "null:dump_everything"]);
  });

  it("do_nothing never calls tools", async () => {
    const run = await newRun();
    const turn = await doNothingAgent.start({ env: miniEnv, scenario: refundScenario, run }).send("refund me");
    expect(turn).toEqual({ reply: "Okay, noted.", transcript: [{ role: "assistant", content: "Okay, noted." }], costMicroUsd: 0 });
    expect(run.trajectory()).toHaveLength(0);
  });

  it("empty_reply replies empty every turn", async () => {
    const s = emptyReplyAgent.start({ env: miniEnv, scenario: refundScenario, run: await newRun() });
    for (let i = 0; i < 2; i++) {
      const t = await s.send("hello");
      expect(t.reply).toBe("");
      expect(t.transcript).toEqual([{ role: "assistant", content: "" }]);
    }
  });

  it("dump_everything dumps once, and state graders still fail it", async () => {
    const run = await newRun();
    const s = dumpEverythingAgent.start({ env: miniEnv, scenario: refundScenario, run });
    const first = await s.send("hi");
    expect(first.reply).toContain("INSERT INTO customers");
    expect(first.reply).toContain("refund_order: Refund an order");
    expect(first.reply.length).toBeLessThanOrEqual(30_001);
    expect((await s.send("again")).reply).toBe("See above.");
    expect(run.trajectory()).toHaveLength(0);
    expect(await run.query(refundScenario.stateAssertions[0]!.sql)).toEqual([{ ok: false }]);
  });
});
