import { describe, expect, it, vi } from "vitest";
import { Finding, Suite, type Scenario } from "../contracts/index";
import type { ServiceContext } from "../contracts/services";
import { GatewayError } from "../ai/gateway";
import { TargetError, type JsonTransport } from "../targets/transport";
import { RED_TEAM_LIBRARY } from "../redteam/library";
import { toScenario } from "../redteam/select";
import { TargetRegistry, decodeDetail, defaultLiteDeps, type LiteDeps } from "./deps";
import { createRunServices } from "./run";

const JOB = "11111111-1111-4111-8111-111111111111";
const KEY = "sk-test-SECRETKEY-123456";
const URL_OK = "https://api.example.com/v1/chat/completions";

const completion = (content: string) => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });

function ctxWith(budget = 1_000_000): ServiceContext {
  return { jobId: JOB, environment: "test", budgetMicroUsd: budget, recordCost: vi.fn(async () => {}), recordProgress: vi.fn(async () => {}) };
}

function fakeGen(passed: boolean, reason = "ok", cost = 100) {
  return vi.fn(async (args: { ctx: { recordCost: (e: never) => Promise<void> } }) => {
    await args.ctx.recordCost({ source: "ai_gateway", agent: "judge", microUsd: cost, meta: {} } as never);
    return { object: { passed, reason }, text: "", provider: "vercel", model: "m", inputTokens: 1, outputTokens: 1, microUsd: cost, costBasis: "list_price_estimate", latencyMs: 1 };
  });
}

function mk(post: JsonTransport["post"], gen = fakeGen(true), opts: { reproduce?: boolean } = { reproduce: false }) {
  const transport = { post: vi.fn(post) } as unknown as JsonTransport & { post: ReturnType<typeof vi.fn> };
  const deps: LiteDeps = defaultLiteDeps({ transport, generateStructured: gen as unknown as LiteDeps["generateStructured"] });
  const registry = new TargetRegistry();
  return { svc: createRunServices(deps, registry, opts), transport, registry, gen };
}

const scen = (id: string, input = "hello", extra: Partial<Scenario> = {}): Scenario => ({
  id, title: `T ${id}`, category: "general", input, checks: [{ kind: "rubric", description: "be nice", spec: {} }], ...extra,
});
const suiteOf = (scenarios: Scenario[]): Suite => ({ jobId: JOB, versionLabel: "v1", frozenAt: new Date().toISOString(), scenarios });
const target = { url: URL_OK, model: "gpt-x", apiKey: KEY, systemPrompt: "You are helpful." };

describe("checkTarget", () => {
  it("rejects http and private IPs without touching the transport", async () => {
    const { svc, transport } = mk(async () => completion("OK"));
    for (const url of ["http://api.example.com/v1", "https://127.0.0.1/v1", "https://localhost/v1", "https://10.0.0.5/x"]) {
      const r = await svc.checkTarget(ctxWith(), { url, model: "m", apiKey: KEY });
      expect(r.ok).toBe(false);
      expect(r.detail).not.toContain(KEY);
    }
    expect(transport.post).not.toHaveBeenCalled();
  });
  it("returns ok on success and a code (no key) on transport failure", async () => {
    expect((await mk(async () => completion("OK")).svc.checkTarget(ctxWith(), { url: URL_OK, model: "m", apiKey: KEY })).ok).toBe(true);
    const bad = mk(async () => { throw new TargetError(`timeout ${KEY}`); });
    const r = await bad.svc.checkTarget(ctxWith(), { url: URL_OK, model: "m", apiKey: KEY });
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(KEY);
  });
});

describe("runSuite", () => {
  it("sends accumulated multi-turn messages and judges", async () => {
    let n = 0;
    const { svc, transport, gen } = mk(async () => completion(`reply${++n}`));
    const s = scen("d1", "t1", { checks: [{ kind: "rubric", description: "r", spec: { turns: ["t1", "t2"] } }] });
    const r = await svc.runSuite(ctxWith(), suiteOf([s]), target);
    expect(transport.post).toHaveBeenCalledTimes(2);
    const second = transport.post.mock.calls[1]![1] as { messages: Array<{ role: string; content: string }> };
    expect(second.messages.map((m) => `${m.role}:${m.content}`)).toEqual(["system:You are helpful.", "user:t1", "assistant:reply1", "user:t2"]);
    expect(transport.post.mock.calls[1]![2]).toBe(KEY);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(r.results[0]!.passed).toBe(true);
    expect(decodeDetail(r.results[0]!.detail)!.grader).toBe("judge");
  });

  it("omits empty system prompt and records judge failure", async () => {
    const { svc, transport } = mk(async () => completion("x"), fakeGen(false, "rude"));
    const r = await svc.runSuite(ctxWith(), suiteOf([scen("d1")]), { ...target, systemPrompt: "" });
    expect((transport.post.mock.calls[0]![1] as { messages: unknown[] }).messages).toHaveLength(1);
    expect(r.results[0]!.passed).toBe(false);
    expect(decodeDetail(r.results[0]!.detail)!.reason).toBe("rude");
  });

  it("grades red-team scenarios deterministically without the judge", async () => {
    const rt = toScenario(RED_TEAM_LIBRARY.find((x) => x.id === "rt_inj_direct_ignore")!);
    const bad = mk(async () => completion("PWNED-4417"));
    const rb = await bad.svc.runSuite(ctxWith(), suiteOf([rt]), target);
    expect(bad.gen).not.toHaveBeenCalled();
    expect(rb.results[0]!.passed).toBe(false);
    const d = decodeDetail(rb.results[0]!.detail)!;
    expect(d.grader).toBe("redteam");
    expect(d.failedRules?.length).toBeGreaterThan(0);
    const good = mk(async () => completion("I can't do that; how can I help?"));
    expect((await good.svc.runSuite(ctxWith(), suiteOf([rt]), target)).results[0]!.passed).toBe(true);
  });

  it("isolates target errors per scenario", async () => {
    let n = 0;
    const { svc } = mk(async () => { if (++n === 1) throw new TargetError("timeout"); return completion("fine"); });
    const r = await svc.runSuite(ctxWith(), suiteOf([scen("a"), scen("b")]), target);
    expect(r.results.map((x) => x.scenarioId)).toEqual(["a", "b"]);
    expect(r.results[0]!.passed).toBe(false);
    const d = decodeDetail(r.results[0]!.detail)!;
    expect(d.grader).toBe("error");
    expect(d.reason).toBe("timeout");
    expect(r.results[1]!.passed).toBe(true);
  });

  it("returns a result even when every scenario errors", async () => {
    const { svc } = mk(async () => { throw new TargetError("blocked_address"); });
    const r = await svc.runSuite(ctxWith(), suiteOf([scen("a"), scen("b")]), target);
    expect(r.results.every((x) => !x.passed)).toBe(true);
  });

  it("skips judging when budget is low or gateway reports exhaustion", async () => {
    const low = mk(async () => completion("x"));
    const r1 = await low.svc.runSuite(ctxWith(10), suiteOf([scen("a")]), target);
    expect(low.gen).not.toHaveBeenCalled();
    expect(decodeDetail(r1.results[0]!.detail)!.reason).toBe("budget_exhausted");
    const thrower = vi.fn(async () => { throw new GatewayError("budget_exhausted", "no"); });
    const ex = mk(async () => completion("x"), thrower as never);
    const r2 = await ex.svc.runSuite(ctxWith(), suiteOf([scen("a")]), target);
    expect(r2.results[0]!.passed).toBe(false);
    expect(decodeDetail(r2.results[0]!.detail)!.reason).toBe("budget_exhausted");
  });

  it("escalates once to the sonnet judge on malformed output", async () => {
    const gen = vi.fn(async (args: { model: string }) => {
      if (args.model === "haiku") throw new GatewayError("malformed_output", "bad json");
      return { object: { passed: true, reason: "fine" }, text: "", provider: "vercel", model: "m", inputTokens: 1, outputTokens: 1, microUsd: 0, costBasis: "list_price_estimate", latencyMs: 1 };
    });
    const m = mk(async () => completion("x"), gen as never);
    const r = await m.svc.runSuite(ctxWith(), suiteOf([scen("a")]), target);
    expect(r.results[0]!.passed).toBe(true);
    expect(gen.mock.calls.map((c) => c[0].model)).toEqual(["haiku", "sonnet"]);
  });

  it("never leaks the api key into results", async () => {
    const { svc } = mk(async () => completion(`my key is ${KEY}`), fakeGen(false, `leaked ${KEY}`));
    const r = await svc.runSuite(ctxWith(), suiteOf([scen("a", `use ${KEY}`)]), target);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(r)).toContain("[redacted]");
  });

  it("runs at most 2 scenarios concurrently and keeps suite order", async () => {
    let active = 0, peak = 0;
    const { svc } = mk(async (_u, body) => {
      active++; peak = Math.max(peak, active);
      await new Promise((res) => setTimeout(res, 10));
      active--;
      return completion(`r-${(body as { messages: Array<{ content: string }> }).messages.at(-1)!.content}`);
    });
    const ids = ["a", "b", "c", "d", "e"];
    const r = await svc.runSuite(ctxWith(), suiteOf(ids.map((i) => scen(i, `in-${i}`))), target);
    expect(peak).toBe(2);
    expect(r.results.map((x) => x.scenarioId)).toEqual(ids);
  });
});

describe("in-run reproduction", () => {
  it("re-runs a failed judge scenario and records the reproduction, stopping after the first", async () => {
    const { svc, transport, gen } = mk(async () => completion("x"), fakeGen(false, "bad"), { reproduce: true });
    const r = await svc.runSuite(ctxWith(), suiteOf([scen("a")]), target);
    const d = decodeDetail(r.results[0]!.detail)!;
    expect(r.results[0]!.passed).toBe(false);
    expect(d.reproductionAttempts).toBe(1);
    expect(d.reproductions).toBe(1);
    expect(transport.post).toHaveBeenCalledTimes(2);
    expect(gen).toHaveBeenCalledTimes(2);
  });
  it("tries twice when the failure does not reproduce, and skips errors and passes", async () => {
    let n = 0;
    const gen = vi.fn(async (a: { ctx: { recordCost: (e: never) => Promise<void> } }) => {
      await a.ctx.recordCost({ source: "ai_gateway", microUsd: 10, meta: {} } as never);
      return { object: { passed: ++n > 1, reason: "r" } };
    });
    const { svc } = mk(async () => completion("x"), gen as never, { reproduce: true });
    const r = await svc.runSuite(ctxWith(), suiteOf([scen("a")]), target);
    const d = decodeDetail(r.results[0]!.detail)!;
    expect(d.reproductionAttempts).toBe(2);
    expect(d.reproductions).toBe(0);
    const err = mk(async () => { throw new TargetError("timeout"); }, fakeGen(true), { reproduce: true });
    const re = await err.svc.runSuite(ctxWith(), suiteOf([scen("a")]), target);
    expect(decodeDetail(re.results[0]!.detail)!.reproductionAttempts).toBeUndefined();
  });
});

describe("rerunFinding", () => {
  const finding = Finding.parse({
    id: "f1", title: "t", status: "rubric_concern", severity: "high", category: "other", description: "d",
    scenarioId: "d1", evidence: [{ kind: "response", excerpt: "orig" }], reproductions: 0,
  });

  it("returns the finding unchanged without a target or scenario", async () => {
    const { svc } = mk(async () => completion("x"));
    expect(await svc.rerunFinding(ctxWith(), finding, scen("d1"))).toEqual(finding);
    svc.runSuite(ctxWith(), suiteOf([]), target);
    expect(await svc.rerunFinding(ctxWith(), finding, undefined)).toEqual(finding);
  });

  it("confirms when the rerun fails again", async () => {
    const { svc } = mk(async () => completion("x"), fakeGen(false, "still bad"));
    await svc.runSuite(ctxWith(), suiteOf([]), target);
    const out = await svc.rerunFinding(ctxWith(), finding, scen("d1"));
    expect(Finding.safeParse(out).success).toBe(true);
    expect(out.id).toBe("f1");
    expect(out.status).toBe("confirmed");
    expect(out.reproductions).toBe(1);
    expect(out.evidence.at(-1)!.excerpt).toBe("Re-run reproduced: still bad");
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("marks inconclusive when not reproduced and caps evidence at 10", async () => {
    const { svc } = mk(async () => completion("x"), fakeGen(true));
    await svc.runSuite(ctxWith(), suiteOf([]), target);
    const many = { ...finding, evidence: Array.from({ length: 10 }, (_, i) => ({ kind: "response" as const, excerpt: `e${i}` })) };
    const out = await svc.rerunFinding(ctxWith(), many, scen("d1"));
    expect(out.status).toBe("inconclusive");
    expect(out.evidence).toHaveLength(10);
    expect(out.evidence.at(-1)!.excerpt).toBe("Re-run did not reproduce");
  });
});
