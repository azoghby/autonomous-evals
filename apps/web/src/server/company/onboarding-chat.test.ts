import { describe, expect, it, vi } from "vitest";
import type { RunPlan } from "@ae/core/company/onboarding";
import type { SandboxDraft, SandboxRunReport } from "@/components/sandbox/contract";
import type { ChatTranscriptEntry, LiveSources } from "./onboarding-chat";
import {
  costEstimateView, hydrateMessages, impliedLiveParts, intakeChecklistView, messageIds, needsModelPicker, resultsSummaryView,
  runProgressView, scenarioPreviewView, turnUiParts, withLastAgentUi,
} from "./onboarding-chat";
import type { StoredUiPart } from "@/components/chat/nova-types";

const READY = { agent: { model: "openai/gpt-5-mini", systemPrompt: "You are a support bot." }, tools: { prebuiltWorld: "acme-support" } };
const item = (v: ReturnType<typeof intakeChecklistView>, id: string) => v.items.find((i) => i.id === id)!;

describe("intakeChecklistView", () => {
  it("marks agent and tools missing and not ready for empty requirements", () => {
    const v = intakeChecklistView({});
    expect(item(v, "agent").state).toBe("missing");
    expect(item(v, "tools").state).toBe("missing");
    expect(v.ready).toBe(false);
  });

  it("is ready when model, system prompt and sample world are collected", () => {
    const v = intakeChecklistView(READY);
    expect(v.ready).toBe(true);
    expect(item(v, "agent")).toMatchObject({ state: "done", required: true });
    expect(item(v, "agent").detail).toContain("openai/gpt-5-mini");
    expect(item(v, "tools").detail).toMatch(/Acme sample world/);
  });

  it("shows the endpoint host for an endpoint agent", () => {
    const v = intakeChecklistView({ agent: { endpointUrl: "https://bot.example.com/v1/chat" }, tools: { prebuiltWorld: "acme-support" } });
    expect(item(v, "agent").detail).toContain("bot.example.com");
    expect(item(v, "agent").detail).not.toContain("/v1/chat");
  });

  it("does not accept a model outside the hosted allowlist", () => {
    const v = intakeChecklistView({ agent: { model: "mystery/model-9", systemPrompt: "x" }, tools: { prebuiltWorld: "acme-support" } });
    expect(item(v, "agent").state).toBe("missing");
    expect(v.ready).toBe(false);
  });

  it("passes notes through and marks optional items", () => {
    const v = intakeChecklistView(READY, ["note one"]);
    expect(v.notes).toEqual(["note one"]);
    expect(item(v, "policies").state).toBe("optional");
    expect(item(v, "data").state).toBe("optional");
  });

  it("marks policies done when policy text is present", () => {
    const v = intakeChecklistView({ ...READY, policies: "No refunds over $100." });
    expect(item(v, "policies").state).toBe("done");
  });
});

describe("needsModelPicker", () => {
  it("is true when the agent target is missing and no endpoint was given", () => {
    expect(needsModelPicker({})).toBe(true);
  });
  it("is false once the agent is collected", () => {
    expect(needsModelPicker(READY)).toBe(false);
  });
  it("is false when the customer gave an endpoint, even an unusable one", () => {
    expect(needsModelPicker({ agent: { endpointUrl: "http://insecure.example.com" } })).toBe(false);
  });
});

describe("costEstimateView", () => {
  const plan = (over: Partial<RunPlan & { headroomMicroUsd: number | null; runCapMicroUsd: number }> = {}) =>
    ({ k: 3, scenarios: 4, estimateMicroUsd: 1_234_567, blocked: false, headroomMicroUsd: 5_000_000, runCapMicroUsd: 3_000_000, ...over });

  it("converts micro-USD to rounded USD and derives trials", () => {
    const v = costEstimateView(plan(), "Pro");
    expect(v).toMatchObject({ scenarios: 4, k: 3, trials: 12, estimateUsd: 1.23, headroomUsd: 5, runCapUsd: 3, planName: "Pro", blocked: false });
  });
  it("keeps a null headroom as null", () => {
    expect(costEstimateView(plan({ headroomMicroUsd: null }), "Free").headroomUsd).toBeNull();
  });
  it("passes blocked through", () => {
    expect(costEstimateView(plan({ blocked: true }), "Free").blocked).toBe(true);
  });
});

/* ---------- fixtures ---------- */

const draftScenario = (id: string, over: Record<string, unknown> = {}) => ({
  scenario: { id, title: `Scenario ${id}`, category: "happy_path" }, validated: undefined, gateReasons: [], ...over,
});
const draft = (over: Record<string, unknown> = {}): SandboxDraft => ({
  draftId: "drf-1", name: "Acme", domain: "support", status: "ready", sample: false, costMicroUsd: 120_000,
  environment: { tools: [{ name: "get_order", effect: "read", description: "Fetch an order", source: "prebuilt" }], tables: ["orders"], policies: [{ title: "Refund policy" }], workflows: [{ name: "Refund flow" }] },
  scenarios: [], ...over,
}) as unknown as SandboxDraft;

describe("scenarioPreviewView gates", () => {
  const gatesFor = (d: Record<string, unknown>) => scenarioPreviewView(draft({ scenarios: [draftScenario("s1", d)] })).scenarios[0]!.gates;

  it("shows every gate pending while the suite is generating", () => {
    const v = scenarioPreviewView(draft({ status: "generating", scenarios: [draftScenario("s1", { validated: true })] }));
    expect(v.scenarios[0]!.gates).toEqual({ oracle: "pending", null: "pending", mutation: "pending" });
    expect(v.scenarios[0]!.validated).toBeNull();
  });
  it("passes all gates for a validated scenario", () => {
    expect(gatesFor({ validated: true })).toEqual({ oracle: "pass", null: "pass", mutation: "pass" });
  });
  it("fails oracle and skips the others when the oracle failed", () => {
    expect(gatesFor({ validated: false, gateReasons: ["oracle failed: x"] })).toEqual({ oracle: "fail", null: "skipped", mutation: "skipped" });
  });
  it("fails the null-agent gate only", () => {
    expect(gatesFor({ validated: false, gateReasons: ["null agent passed: y"] })).toEqual({ oracle: "pass", null: "fail", mutation: "pass" });
  });
  it("fails the mutation gate on a weak grader", () => {
    expect(gatesFor({ validated: false, gateReasons: ["weak grader: mutation survived"] })).toEqual({ oracle: "pass", null: "pass", mutation: "fail" });
  });
  it("treats an ungated scenario as pending", () => {
    expect(gatesFor({ validated: false, gateReasons: ["not gated"] })).toEqual({ oracle: "pending", null: "pending", mutation: "pending" });
  });
  it("counts validated scenarios and converts cost", () => {
    const v = scenarioPreviewView(draft({ scenarios: [draftScenario("a", { validated: true }), draftScenario("b", { validated: false })] }));
    expect(v).toMatchObject({ total: 2, validated: 1, costUsd: 0.12, status: "ready" });
  });
});

const trial = (n: number, passed: boolean, extra: Record<string, unknown> = {}) => ({
  trial: n, passed, checks: passed ? [] : [{ passed: false, detail: "refund exceeded limit" }],
  transcript: [{ role: "user", content: "refund me" }, { role: "assistant", content: "Sure, refunded $500." }], ...extra,
});
const report = (over: Record<string, unknown> = {}): SandboxRunReport => ({
  runId: "run 1", status: "running", k: 3, costMicroUsd: 500_000, budgetMicroUsd: 3_000_000,
  scenarios: [{ id: "s1", title: "Refund", category: "boundary" }, { id: "s2", title: "Lookup", category: "happy_path" }],
  results: [], clusters: [], progress: { trialsDone: 0, trialsTotal: 6 }, ...over,
}) as unknown as SandboxRunReport;

describe("runProgressView", () => {
  it("renders pass/fail from finished trials and pending for the rest", () => {
    const v = runProgressView(report({ progress: { trialsDone: 2, trialsTotal: 6 }, results: [{ scenarioId: "s1", passRate: 0.5, reliable: false, trials: [trial(0, true), trial(1, false)] }] }));
    expect(v.rows[0]!.cells).toEqual(["pass", "fail", "pending"]);
    expect(v.rows[1]!.cells).toEqual(["pending", "pending", "pending"]);
  });
  it("marks in-flight trials (progress minus finished) as running", () => {
    const v = runProgressView(report({ progress: { trialsDone: 3, trialsTotal: 6 }, results: [{ scenarioId: "s1", passRate: 1, reliable: false, trials: [trial(0, true)] }] }));
    expect(v.rows[0]!.cells).toEqual(["pass", "running", "running"]);
    expect(v.rows[1]!.cells).toEqual(["pending", "pending", "pending"]);
  });
  it("encodes the run id in the run url and converts budget", () => {
    const v = runProgressView(report());
    expect(v.runUrl).toBe("/sandbox/runs/run%201");
    expect(v).toMatchObject({ costUsd: 0.5, budgetUsd: 3, trialsTotal: 6, k: 3 });
  });
  it("reports all trials done once complete", () => {
    expect(runProgressView(report({ status: "complete", progress: { trialsDone: 1, trialsTotal: 6 } })).trialsDone).toBe(6);
  });
});

describe("resultsSummaryView", () => {
  const complete = report({
    status: "complete",
    results: [
      { scenarioId: "s1", passRate: 1 / 3, reliable: false, trials: [trial(0, true), trial(1, false), trial(2, false)] },
      { scenarioId: "s2", passRate: 1, reliable: true, trials: [trial(0, true), trial(1, true), trial(2, true)] },
    ],
    clusters: [{ id: "c1", title: "Over-refund", rootCause: "No limit check", severity: "high", attribution: "agent", trialCount: 2, scenarioIds: ["s1"] }],
  });

  it("builds evidence only from failing trials, with 1-based trial numbers", () => {
    const v = resultsSummaryView(complete);
    expect(v.evidence.map((e) => e.id)).toEqual(["s1:1", "s1:2"]);
    expect(v.evidence[0]).toMatchObject({ scenarioTitle: "Refund", trial: 2, check: "refund exceeded limit", excerpt: "Sure, refunded $500.", role: "assistant" });
  });
  it("links cluster evidence ids to the cluster's scenarios", () => {
    const v = resultsSummaryView(complete);
    expect(v.clusters[0]!.evidence).toEqual(["s1:1", "s1:2"]);
  });
  it("aggregates passed/total by category", () => {
    const v = resultsSummaryView(complete);
    expect(v.byCategory).toEqual(expect.arrayContaining([{ category: "boundary", passed: 1, total: 3 }, { category: "happy_path", passed: 3, total: 3 }]));
  });
  it("summarises scenarios, trials and cost", () => {
    expect(resultsSummaryView(complete)).toMatchObject({ scenarios: 2, trials: 6, runUrl: "/sandbox/runs/run%201", costUsd: 0.5 });
  });
  it("caps evidence at eight items", () => {
    const many = report({ status: "complete", results: [{ scenarioId: "s1", passRate: 0, reliable: false, trials: Array.from({ length: 12 }, (_, i) => trial(i, false)) }] });
    expect(resultsSummaryView(many).evidence).toHaveLength(8);
  });
});

describe("turnUiParts", () => {
  const cost = { scenarios: 4, k: 3, trials: 12, estimateUsd: 1, headroomUsd: null, runCapUsd: 3, planName: "Pro", blocked: false };

  it("shows the checklist and a model picker when the agent is missing", () => {
    const parts = turnUiParts({ status: "collecting", collected: {} }, "m1");
    expect(parts.map((p) => p.tool)).toEqual(["intakeChecklist", "modelPicker"]);
    expect(parts[0]!.id).toBe("m1-intakeChecklist");
  });
  it("omits the picker once the agent is collected", () => {
    expect(turnUiParts({ status: "collecting", collected: READY }, "m1").map((p) => p.tool)).toEqual(["intakeChecklist"]);
  });
  it("adds the cost estimate when awaiting confirmation", () => {
    const parts = turnUiParts({ status: "collecting", collected: READY, awaitingConfirm: true, cost }, "m1");
    expect(parts.map((p) => p.tool)).toEqual(["intakeChecklist", "costEstimate"]);
    expect(parts[1]!.output).toEqual(cost);
  });
  it("references the live draft with null output while building", () => {
    const parts = turnUiParts({ status: "building", collected: READY, suiteId: "drf-1" }, "m1");
    expect(parts.map((p) => p.tool)).toEqual(["environmentCard", "scenarioPreview"]);
    expect(parts.every((p) => p.output === null && (p.input as { suiteId: string }).suiteId === "drf-1")).toBe(true);
  });
  it("emits nothing while building without a suite id", () => {
    expect(turnUiParts({ status: "building", collected: READY }, "m1")).toEqual([]);
  });
});

const T = (n: number) => new Date(Date.UTC(2026, 5, 1, 12, 0, n)).toISOString();
const entry = (role: string, text: string, n: number, ui?: StoredUiPart[]): ChatTranscriptEntry => ({ role, text, at: T(n), ...(ui ? { ui } : {}) });
const sp = (id: string, tool: StoredUiPart["tool"] = "intakeChecklist"): StoredUiPart => ({ tool, id, input: {}, output: null }) as unknown as StoredUiPart;

describe("withLastAgentUi", () => {
  it("adds ui only to the last agent entry without mutating the input", () => {
    const t = [entry("agent", "a", 1), entry("customer", "c", 2), entry("agent", "b", 3)];
    const snapshot = JSON.stringify(t);
    const out = withLastAgentUi(t, [sp("p1")]);
    expect(JSON.stringify(t)).toBe(snapshot);
    expect(out[0]!.ui).toBeUndefined();
    expect(out[2]!.ui?.map((p) => p.id)).toEqual(["p1"]);
    expect(out).not.toBe(t);
  });
  it("dedupes parts already on the entry by id", () => {
    const out = withLastAgentUi([entry("agent", "a", 1, [sp("p1")])], [sp("p1"), sp("p2")]);
    expect(out[0]!.ui?.map((p) => p.id)).toEqual(["p1", "p2"]);
  });
  it("returns a copy unchanged when there is no agent entry or no parts", () => {
    const t = [entry("customer", "c", 1)];
    expect(withLastAgentUi(t, [sp("p1")])).toEqual(t);
    expect(withLastAgentUi([entry("agent", "a", 1)], [])[0]!.ui).toBeUndefined();
  });
});

describe("impliedLiveParts", () => {
  const tr = [entry("agent", "a", 1)];
  it("is empty without a run id or in non-run statuses", () => {
    expect(impliedLiveParts({ status: "running", runId: null, transcript: tr })).toEqual([]);
    expect(impliedLiveParts({ status: "collecting", runId: "r1", transcript: tr })).toEqual([]);
  });
  it("implies progress while running", () => {
    expect(impliedLiveParts({ status: "running", runId: "r1", transcript: tr }).map((p) => p.tool)).toEqual(["runProgress"]);
  });
  it("implies progress and results once reported", () => {
    const parts = impliedLiveParts({ status: "reported", runId: "r1", transcript: tr });
    expect(parts.map((p) => p.tool)).toEqual(["runProgress", "resultsSummary"]);
    expect(parts[0]!.id).toBe("run-r1-runProgress");
  });
  it("skips parts a transcript entry already references for this run", () => {
    const ref = { tool: "runProgress", id: "x", input: { runId: "r1" }, output: null } as unknown as StoredUiPart;
    const parts = impliedLiveParts({ status: "reported", runId: "r1", transcript: [entry("agent", "a", 1, [ref])] });
    expect(parts.map((p) => p.tool)).toEqual(["resultsSummary"]);
  });
});

describe("messageIds", () => {
  it("prefixes by role and uses the timestamp", () => {
    const ids = messageIds([{ role: "customer", at: T(1) }, { role: "agent", at: T(1) }]);
    expect(ids[0]).toMatch(/^u-\d+$/);
    expect(ids[1]).toMatch(/^a-\d+$/);
  });
  it("is stable when earlier entries are trimmed away", () => {
    const all = [{ role: "customer", at: T(1) }, { role: "agent", at: T(2) }, { role: "customer", at: T(3) }];
    expect(messageIds(all.slice(1))).toEqual(messageIds(all).slice(1));
  });
  it("dedupes identical keys with a counter suffix", () => {
    const ids = messageIds([{ role: "agent", at: T(1) }, { role: "agent", at: T(1) }, { role: "agent", at: T(1) }]);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(`${ids[0]}-1`);
    expect(ids[2]).toBe(`${ids[0]}-2`);
  });
});

describe("hydrateMessages", () => {
  const src = (over: Partial<LiveSources> = {}): LiveSources => ({ getDraft: vi.fn(async () => null), getRunReport: vi.fn(async () => null), ...over });
  const live = (tool: StoredUiPart["tool"], input: object): StoredUiPart => ({ tool, id: `id-${tool}`, input, output: null }) as unknown as StoredUiPart;

  it("maps customer/agent entries to user/assistant messages with a text part and metadata", async () => {
    const msgs = await hydrateMessages({ id: "c1", status: "collecting", runId: null, transcript: [entry("customer", "hi", 1), entry("system", "skip", 2), entry("agent", "hello", 3)] }, src());
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.parts[0]).toEqual({ type: "text", text: "hello", state: "done" });
    expect(msgs[1]!.metadata).toMatchObject({ conversationId: "c1", status: "collecting", at: T(3) });
  });

  it("passes stored (non-live) outputs through as output-available", async () => {
    const stored = { tool: "intakeChecklist", id: "p1", input: {}, output: { ready: false, items: [], notes: [] } } as unknown as StoredUiPart;
    const [m] = await hydrateMessages({ id: "c1", status: "collecting", runId: null, transcript: [entry("agent", "a", 1, [stored])] }, src());
    expect(m!.parts[1]).toMatchObject({ type: "tool-intakeChecklist", state: "output-available", toolCallId: "p1" });
  });

  it("turns a missing draft into an output-error tool part", async () => {
    const [m] = await hydrateMessages({ id: "c1", status: "building", runId: null, transcript: [entry("agent", "a", 1, [live("scenarioPreview", { suiteId: "drf-9" })])] }, src());
    expect(m!.parts[1]).toMatchObject({ type: "tool-scenarioPreview", state: "output-error", errorText: expect.stringMatching(/no longer available/) });
  });

  it("hydrates a live draft into the current view", async () => {
    const getDraft = vi.fn(async () => draft({ scenarios: [draftScenario("s1", { validated: true })] }));
    const [m] = await hydrateMessages({ id: "c1", status: "building", runId: null, transcript: [entry("agent", "a", 1, [live("scenarioPreview", { suiteId: "drf-1" }), live("environmentCard", { suiteId: "drf-1" })])] }, src({ getDraft }));
    expect(m!.parts[1]).toMatchObject({ state: "output-available", output: { validated: 1 } });
    expect(m!.parts[2]).toMatchObject({ state: "output-available", output: { name: "Acme" } });
    expect(getDraft).toHaveBeenCalledTimes(1);
  });

  it("errors resultsSummary when the report is not complete", async () => {
    const getRunReport = vi.fn(async () => report({ status: "failed", error: "budget hit" }));
    const [m] = await hydrateMessages({ id: "c1", status: "reported", runId: null, transcript: [entry("agent", "a", 1, [live("resultsSummary", { runId: "r1" })])] }, src({ getRunReport }));
    expect(m!.parts[1]).toMatchObject({ type: "tool-resultsSummary", state: "output-error", errorText: "budget hit" });
  });

  it("appends implied run parts to the last agent entry", async () => {
    const getRunReport = vi.fn(async () => report());
    const msgs = await hydrateMessages({ id: "c1", status: "running", runId: "r1", transcript: [entry("customer", "go", 1), entry("agent", "started", 2)] }, src({ getRunReport }));
    expect(msgs[1]!.parts.map((p) => p.type)).toEqual(["text", "tool-runProgress"]);
    expect(msgs[1]!.parts[1]).toMatchObject({ state: "output-available" });
  });

  it("treats a throwing live source as unavailable", async () => {
    const getDraft = vi.fn(async () => { throw new Error("db down"); });
    const [m] = await hydrateMessages({ id: "c1", status: "building", runId: null, transcript: [entry("agent", "a", 1, [live("environmentCard", { suiteId: "x" })])] }, src({ getDraft }));
    expect(m!.parts[1]).toMatchObject({ state: "output-error" });
  });
});
