import { describe, expect, it, vi } from "vitest";

vi.mock("@ae/core/db/client", () => ({ db: vi.fn(), schema: {} }));
vi.mock("@ae/core/ai/gateway", () => ({ generateStructured: vi.fn(), GatewayError: class GatewayError extends Error { code = "malformed_output"; } }));
vi.mock("@ae/core/email/agentmail", () => ({ replyInThread: vi.fn() }));
vi.mock("./operator-alerts", () => ({ alertOperators: vi.fn(), redactAlertText: (s: string) => s }));
vi.mock("./rate-limit", () => ({ rateLimit: vi.fn() }));
vi.mock("./owner-shared", () => ({
  appUrl: () => "https://app.test", footerFor: () => "--FOOTER--", recordOwnerEmail: vi.fn(), suppressEmail: vi.fn(),
}));

import { HUMAN_HANDOFF_TEXT, OWNER_TOOLS, respondToOwner, type AgentFacts, type ResponderDeps, type RunFacts } from "./owner-responder";

const NOW = new Date("2026-11-07T12:00:00Z");
const baseAgent: AgentFacts = { id: "a1", name: "Acme Bot", ownerEmail: "o@acme.com", visibility: "public", status: "active", rerunRequestedAt: null };
const run = (hoursAgo: number, over: Partial<RunFacts> = {}): RunFacts => ({
  ranAt: new Date(NOW.getTime() - hoursAgo * 3600_000), passed: 8, total: 10, byCategory: { safety: { passed: 4, total: 5 } },
  findings: [{ title: "Leaks prompt", severity: "high", category: "redteam:leak", scenarioId: "s1", excerpt: "see https://secret.acme.com/x token sk-abcdefghijklmnopqrstuvwxyz" }], ...over,
});

function setup(o: { agent?: Partial<AgentFacts>; runs?: RunFacts[]; llm?: unknown | (() => never); limitOk?: boolean } = {}) {
  const agent = { ...baseAgent, ...o.agent };
  const state = { patches: [] as unknown[], suppressed: [] as string[], replies: [] as string[], alerts: [] as { kind: string }[], prompts: [] as string[] };
  const deps: ResponderDeps = {
    loadAgent: async () => ({ agent, runs: o.runs ?? [run(100)] }),
    updateAgent: async (_id, patch, guard) => {
      if (guard?.onlyIfStatus && guard.onlyIfStatus !== agent.status) return false;
      const ran = guard?.noPendingRerunSince?.latestRanAt;
      if (guard?.noPendingRerunSince && agent.rerunRequestedAt && (!ran || agent.rerunRequestedAt > ran)) return false;
      state.patches.push(patch); return true;
    },
    suppress: async (e) => { state.suppressed.push(e); },
    llm: async (_s, p) => { state.prompts.push(p); if (typeof o.llm === "function") return (o.llm as () => unknown)(); return o.llm; },
    reply: async (_i, _m, text) => { state.replies.push(text); return { messageId: "r1", threadId: "t1" }; },
    recordEmail: async () => {},
    alert: async (a) => { state.alerts.push(a); },
    limit: async () => ({ ok: o.limitOk ?? true }),
    now: () => NOW,
  };
  const go = (body = "hi") => respondToOwner({ agentId: "a1", inboxId: "in", messageId: "m1", body }, deps);
  return { go, state };
}
const out = (tools: Array<{ tool: string; visibility?: string }>, over = {}) => ({ actions: tools, reply: "Sure thing.", confidence: 0.9, ...over });

describe("respondToOwner", () => {
  it("exposes the fixed tool allow-list", () => {
    expect([...OWNER_TOOLS]).toEqual(["answer_results", "request_rerun", "pause", "unpause", "set_visibility", "opt_out", "start_paid_eval", "escalate"]);
  });

  it("escalates an unknown tool with no DB change", async () => {
    const { go, state } = setup({ llm: out([{ tool: "delete_everything" }, { tool: "pause" }]) });
    expect(await go()).toBe("owner_escalated");
    expect(state.patches).toEqual([]);
    expect(state.alerts[0]?.kind).toBe("owner_reply_needs_human");
    expect(state.replies[0]).toContain(HUMAN_HANDOFF_TEXT);
  });

  it("escalates on low confidence, applying no state changes", async () => {
    const { go, state } = setup({ llm: out([{ tool: "pause" }], { confidence: 0.4 }) });
    expect(await go()).toBe("owner_escalated");
    expect(state.patches).toEqual([]);
    expect(state.alerts).toHaveLength(1);
    expect(state.replies[0]).toContain(HUMAN_HANDOFF_TEXT);
  });

  it("escalates on an explicit escalate action and on LLM errors", async () => {
    const a = setup({ llm: out([{ tool: "escalate" }]) });
    expect(await a.go()).toBe("owner_escalated");
    const b = setup({ llm: () => { throw new Error("boom"); } });
    expect(await b.go()).toBe("owner_escalated");
    expect(b.state.alerts).toHaveLength(1);
  });

  it("escalates without calling the LLM when rate limited", async () => {
    const { go, state } = setup({ limitOk: false, llm: out([]) });
    expect(await go()).toBe("owner_escalated");
    expect(state.prompts).toEqual([]);
  });

  it("honors opt_out even when escalating, ignoring other actions", async () => {
    const { go, state } = setup({ llm: out([{ tool: "pause" }, { tool: "opt_out" }, { tool: "escalate" }]) });
    expect(await go("stop. also complaint")).toBe("owner_escalated");
    expect(state.patches).toEqual([{ status: "opted_out", active: false, apiKeyCiphertext: null }]);
    expect(state.suppressed).toEqual(["o@acme.com"]);
  });

  it("pauses and reports what was actually done", async () => {
    const { go, state } = setup({ llm: out([{ tool: "pause" }]) });
    expect(await go()).toBe("owner_replied");
    expect(state.patches).toEqual([{ status: "paused", active: false }]);
    expect(state.replies[0]).toContain("What I did:\n- Paused weekly runs.");
    expect(state.replies[0]).toContain("--FOOTER--");
  });

  it("does not claim a pause that did not happen", async () => {
    const { go, state } = setup({ agent: { status: "paused" }, llm: out([{ tool: "pause" }]) });
    await go();
    expect(state.patches).toEqual([]);
    expect(state.replies[0]).not.toContain("What I did");
    expect(state.replies[0]).toContain("not paused");
  });

  it("unpauses only from paused", async () => {
    const a = setup({ agent: { status: "paused" }, llm: out([{ tool: "unpause" }]) });
    await a.go();
    expect(a.state.patches).toEqual([{ status: "active", active: true }]);
    const b = setup({ llm: out([{ tool: "unpause" }]) });
    await b.go();
    expect(b.state.patches).toEqual([]);
  });

  it("sets visibility", async () => {
    const { go, state } = setup({ llm: out([{ tool: "set_visibility", visibility: "private" }]) });
    await go();
    expect(state.patches).toEqual([{ visibility: "private" }]);
    expect(state.replies[0]).toContain("private");
  });

  it("opt_out clears the key, suppresses the owner and replies", async () => {
    const { go, state } = setup({ llm: out([{ tool: "opt_out" }]) });
    expect(await go("please stop")).toBe("owner_replied");
    expect(state.patches).toEqual([{ status: "opted_out", active: false, apiKeyCiphertext: null }]);
    expect(state.suppressed).toEqual(["o@acme.com"]);
    expect(state.replies).toHaveLength(1);
  });

  it("gates request_rerun on a 24h gap", async () => {
    const recent = setup({ runs: [run(3)], llm: out([{ tool: "request_rerun" }]) });
    await recent.go();
    expect(recent.state.patches).toEqual([]);
    expect(recent.state.replies[0]).toContain("within the last 24 hours");
    const old = setup({ runs: [run(30)], llm: out([{ tool: "request_rerun" }]) });
    await old.go();
    expect(old.state.patches).toEqual([{ rerunRequestedAt: NOW }]);
    expect(old.state.replies[0]).toContain("Queued a re-run");
    const queued = setup({ runs: [run(30)], agent: { rerunRequestedAt: NOW }, llm: out([{ tool: "request_rerun" }]) });
    await queued.go();
    expect(queued.state.patches).toEqual([]);
    expect(queued.state.replies[0]).toContain("already queued");
    const stale = setup({ runs: [run(30)], agent: { rerunRequestedAt: new Date(NOW.getTime() - 40 * 3600_000) }, llm: out([{ tool: "request_rerun" }]) });
    await stale.go();
    expect(stale.state.patches).toEqual([{ rerunRequestedAt: NOW }]);
    const noRun = setup({ runs: [], llm: out([{ tool: "request_rerun" }]) });
    await noRun.go();
    expect(noRun.state.patches).toEqual([{ rerunRequestedAt: NOW }]);
  });

  it("appends the checkout link for start_paid_eval", async () => {
    const { go, state } = setup({ llm: out([{ tool: "start_paid_eval" }]) });
    await go();
    expect(state.replies[0]).toContain("https://app.test/start");
  });

  it("keeps secrets and other agents out of the prompt and wraps the body", async () => {
    const { go, state } = setup({ llm: out([{ tool: "answer_results" }]) });
    await go("x".repeat(9000));
    const p = state.prompts[0]!;
    expect(p).toContain("Acme Bot");
    expect(p).toContain("<owner_email>");
    expect(p).not.toMatch(/sk-abcdefghij|secret\.acme\.com|ciphertext|apiKey|endpoint|ipHash|systemPrompt/i);
    expect(p.length).toBeLessThan(9000);
  });
});
