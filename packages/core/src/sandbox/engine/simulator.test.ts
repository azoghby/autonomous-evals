import { describe, expect, it } from "vitest";
import { SandboxScenario } from "../spec";
import { addDistractor, applyTypos, attributeFailure, llmSimulator, parseTraits, scriptedSimulator, simulatorContradictions } from "./simulator";
import { fakeGateway, memoryCtx } from "./testing/fake-gateway";
import { miniEnv, refundScenario } from "./testing/fixtures";
import type { ConversationMessage } from "./types";

const NEVER = "I already got a refund last week";
const withNever = SandboxScenario.parse({
  ...refundScenario,
  persona: { ...refundScenario.persona, knowledge: [...refundScenario.persona.knowledge, { fact: NEVER, revealWhen: "never" }] },
});

function setup(handler: Parameters<typeof fakeGateway>[0]) {
  const gw = fakeGateway(handler);
  const ctx = memoryCtx();
  return { gw, ctx, deps: { gateway: gw, ctx } };
}
const reply = { message: "Hi, I need a refund for o_100", status: "continue" };

describe("llmSimulator", () => {
  it("pins the model and builds a constrained prompt", async () => {
    const { gw, deps } = setup(() => reply);
    const f = llmSimulator(deps);
    expect(f.model).toBe("anthropic/claude-haiku-5.5");
    const turn = await f.start({ env: miniEnv, scenario: withNever, variant: "base", trial: 0 }).next([]);
    expect(turn.message).toBe(reply.message);
    expect(turn.costMicroUsd).toBe(100);
    const call = gw.calls[0]!;
    expect(call.agent).toBe("operator");
    expect(call.temperature).toBe(0.4);
    expect(call.system).not.toContain(NEVER);
    expect(call.system).toContain("My order id is o_100");
    expect(call.system).toContain("ONLY after the support agent explicitly asks");
    expect(call.system).toContain("My email is ann@example.com");
  });

  it("uses higher temperature for adversarial personas and includes the visible conversation", async () => {
    const { gw, deps } = setup(() => ({ message: "ok", status: "continue" }));
    const adv = SandboxScenario.parse({ ...refundScenario, persona: { ...refundScenario.persona, adversarial: true } });
    const conv: ConversationMessage[] = [{ role: "user", content: "hello there" }, { role: "assistant", content: "What is your email?" }];
    await llmSimulator(deps).start({ env: miniEnv, scenario: adv, variant: "base", trial: 0 }).next(conv);
    expect(gw.calls[0]!.temperature).toBe(0.7);
    expect(gw.calls[0]!.prompt).toContain("Support agent: What is your email?");
    expect(gw.calls[0]!.system).toContain("ADVERSARIAL");
  });

  it("applies variants to the opening only and forces continue", async () => {
    const msg = "Please refund my order o_100 because it arrived damaged and broken";
    const { gw, deps } = setup(() => ({ message: msg, status: "goal_achieved" }));
    const run = async (variant: "base" | "paraphrase" | "typo" | "distractor") => {
      const s = llmSimulator(deps).start({ env: miniEnv, scenario: refundScenario, variant, trial: 1 });
      return { open: await s.next([]), later: await s.next([{ role: "user", content: "x" }, { role: "assistant", content: "y" }]) };
    };
    const base = await run("base");
    expect(base.open.message).toBe(msg);
    expect(base.open.status).toBe("continue");
    expect(base.later.status).toBe("goal_achieved");
    const typo = await run("typo");
    expect(typo.open.message).not.toBe(msg);
    expect(typo.open.message).toContain("o_100");
    expect(typo.later.message).toBe(msg);
    const dis = await run("distractor");
    expect(dis.open.message).not.toBe(msg);
    expect(dis.later.message).toBe(msg);
    await run("paraphrase");
    const para = gw.calls.filter((c) => c.prompt.includes("paraphrase seed"));
    expect(para).toHaveLength(1);
  });

  it("clips overlong messages", async () => {
    const { deps } = setup(() => ({ message: "a".repeat(2000), status: "continue" }));
    const t = await llmSimulator(deps).start({ env: miniEnv, scenario: refundScenario, variant: "distractor", trial: 0 }).next([]);
    expect(t.message.length).toBeLessThanOrEqual(2001);
  });
});

describe("parseTraits", () => {
  it("parses numbers and levels", () => {
    expect(parseTraits("traits: impatience=0.3, confusion=high; skepticism = low verbosity=1")).toEqual({ impatience: 0.3, confusion: 0.8, skepticism: 0.2, verbosity: 1 });
  });
  it("ignores junk and renders high impatience instructions", async () => {
    expect(parseTraits("polite, calm")).toEqual({});
    const { gw, deps } = setup(() => reply);
    const sc = SandboxScenario.parse({ ...refundScenario, persona: { ...refundScenario.persona, style: "impatience=0.9" } });
    await llmSimulator(deps).start({ env: miniEnv, scenario: sc, variant: "base", trial: 0 }).next([]);
    expect(gw.calls[0]!.system).toContain("very impatient");
  });
});

describe("applyTypos / addDistractor", () => {
  const text = "Please refund order o_100 and email ann@example.com about the damaged package today";
  it("is deterministic, changes text, preserves ids and emails", () => {
    const a = applyTypos(text, "s1");
    expect(a).toBe(applyTypos(text, "s1"));
    expect(a).not.toBe(text);
    expect(a).toContain("o_100");
    expect(a).toContain("ann@example.com");
    expect(a.split(" ").length).toBe(text.split(" ").length);
  });
  it("returns text unchanged when nothing eligible", () => {
    expect(applyTypos("o_1 a@b.c", "x")).toBe("o_1 a@b.c");
  });
  it("addDistractor is deterministic and keeps the text", () => {
    const d = addDistractor("Refund o_100", "s");
    expect(d).toBe(addDistractor("Refund o_100", "s"));
    expect(d).toContain("Refund o_100");
    expect(d.length).toBeGreaterThan("Refund o_100".length);
  });
});

describe("scriptedSimulator", () => {
  it("opens with goal + upfront facts, then drip-feeds facts, then abandons", async () => {
    const f = scriptedSimulator({ maxTurns: 10 });
    expect(f.model).toBe("scripted");
    const s = f.start({ env: miniEnv, scenario: refundScenario, variant: "base", trial: 0 });
    const open = await s.next([]);
    expect(open.message).toBe("Get a refund for order o_100. My order id is o_100");
    expect(open.costMicroUsd).toBe(0);
    const conv: ConversationMessage[] = [{ role: "user", content: open.message }, { role: "assistant", content: "?" }];
    expect((await s.next(conv)).message).toBe("Here you go: My customer id is c_1");
    expect((await s.next(conv)).message).toBe("Here you go: My email is ann@example.com");
    expect(await s.next(conv)).toMatchObject({ message: "Is that done?", status: "continue" });
    expect(await s.next(conv)).toMatchObject({ message: "", status: "abandoned" });
  });
  it("respects maxTurns", async () => {
    const s = scriptedSimulator({ maxTurns: 1 }).start({ env: miniEnv, scenario: refundScenario, variant: "base", trial: 0 });
    const t = await s.next([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
    expect(t.status).toBe("abandoned");
  });
});

describe("attributeFailure", () => {
  const leaking = [{ role: "user" as const, content: `Well ${NEVER.toUpperCase()}.` }, { role: "assistant" as const, content: "ok" }];
  const clean = [{ role: "user" as const, content: "refund o_100" }, { role: "assistant" as const, content: "Done" }];

  it("detects never-fact leaks deterministically without a model call", async () => {
    const { gw, deps } = setup(() => ({}));
    expect(simulatorContradictions(withNever, leaking)).toHaveLength(1);
    expect(simulatorContradictions(withNever, clean)).toEqual([]);
    const r = await attributeFailure(deps, { scenario: withNever, transcript: leaking });
    expect(r.attribution).toBe("simulator");
    expect(r.costMicroUsd).toBe(0);
    expect(gw.calls).toHaveLength(0);
  });

  it("uses the judge, with all facts visible and costs recorded", async () => {
    const { gw, ctx, deps } = setup(() => ({ simulatorError: true, kinds: ["invented_fact"], reason: "Made up an email" }));
    const r = await attributeFailure(deps, { scenario: withNever, transcript: clean });
    expect(r).toEqual({ attribution: "simulator", reasons: ["invented_fact", "Made up an email"], costMicroUsd: 100 });
    expect(gw.calls[0]!.agent).toBe("judge");
    expect(gw.calls[0]!.temperature).toBe(0);
    expect(gw.calls[0]!.prompt).toContain(NEVER);
    expect(ctx.costs).toEqual([100]);
  });

  it("attributes to agent when the judge finds no simulator error", async () => {
    const { deps } = setup(() => ({ simulatorError: false, kinds: [], reason: "Simulator behaved" }));
    const r = await attributeFailure(deps, { scenario: refundScenario, transcript: clean });
    expect(r.attribution).toBe("agent");
  });

  it("returns unknown on model errors", async () => {
    const { deps } = setup(() => { throw new Error("boom ".repeat(100)); });
    const r = await attributeFailure(deps, { scenario: refundScenario, transcript: clean });
    expect(r.attribution).toBe("unknown");
    expect(r.reasons[0]!.length).toBeLessThanOrEqual(301);
  });
});
