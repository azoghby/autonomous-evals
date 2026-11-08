import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONCEPT_TOPICS } from "@/lib/eval-chat/types";
import { buildEvalTools } from "./tools";
import {
  FAKE_SECRET, JOB_ID, OTHER_RUN_ID, OWNER, RUN_ID, SC_FLAKY, SC_PASS, SC_POLICY, TRANSCRIPT_MARKER, jobCtx, makeDeps, makeReport, ownTarget, sandboxCtx,
} from "./fixtures.testing";

const OPTS = { toolCallId: "t", messages: [], context: undefined };
/** Calls a tool's execute directly (input validation is the AI SDK's job and is covered by the schema test below). */
async function call<T = Record<string, unknown>>(tool: unknown, input: unknown = {}): Promise<T> {
  return (await (tool as { execute: (i: unknown, o: unknown) => unknown }).execute(input, OPTS)) as T;
}

let t: ReturnType<typeof makeDeps>;
beforeEach(() => { t = makeDeps(); });
afterEach(() => vi.restoreAllMocks());

const leakyReport = () => makeReport({}, {
  failingTranscript: [
    { role: "user", content: "refund me" },
    { role: "assistant", content: `Sure, my key is ${FAKE_SECRET} and also Authorization: Bearer abcdefghijklmnop1234` },
  ],
});

describe("secret redaction in tool output", () => {
  it("explain_failure redacts a secret found in a transcript line", async () => {
    const tools = buildEvalTools(sandboxCtx({ report: leakyReport() }), t.deps);
    const out = await call<{ excerpt: Array<{ content: string }> }>(tools.explain_failure, { scenarioId: SC_FLAKY });
    const text = JSON.stringify(out);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain("abcdefghijklmnop1234");
    expect(out.excerpt.at(-1)!.content).toContain("[REDACTED]");
  });
  it("get_trial_timeline redacts secrets in transcript turns and in tool-call arguments", async () => {
    const r = leakyReport();
    r.results[1].trials[1].toolCalls[0].args = { api_key: FAKE_SECRET, note: FAKE_SECRET };
    const out = await call(buildEvalTools(sandboxCtx({ report: r }), t.deps).get_trial_timeline, { scenarioId: SC_FLAKY });
    expect(JSON.stringify(out)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });
  it("get_state_diff redacts secrets stored in database rows", async () => {
    const r = makeReport();
    r.results[1].trials[1].diff[0].sample[0].after = { id: "r1", note: FAKE_SECRET };
    const out = await call(buildEvalTools(sandboxCtx({ report: r }), t.deps).get_state_diff, { scenarioId: SC_FLAKY });
    expect(JSON.stringify(out)).not.toContain(FAKE_SECRET);
  });
  it("get_finding redacts secrets in audit evidence", async () => {
    const ctx = jobCtx();
    (ctx.job.findings[0] as { data: { evidence: Array<{ excerpt: string }> } }).data.evidence[0].excerpt = `token ${FAKE_SECRET}`;
    const out = await call(buildEvalTools(ctx, t.deps).get_finding, { findingId: "F1" });
    expect(JSON.stringify(out)).not.toContain(FAKE_SECRET);
  });
});

describe("read tools", () => {
  it("get_overview returns the run summary for sandbox runs and the audit summary for jobs", async () => {
    expect(await call(buildEvalTools(sandboxCtx(), t.deps).get_overview)).toMatchObject({ runId: RUN_ID, scenarios: 3, trials: 6 });
    expect(await call(buildEvalTools(jobCtx(), t.deps).get_overview)).toMatchObject({ jobId: JOB_ID, delivered: true, bySeverity: { critical: 1 } });
  });
  it("explain_failure returns grounded evidence with a 1-based trial", async () => {
    const out = await call(buildEvalTools(sandboxCtx(), t.deps).explain_failure, { scenarioId: "Refund with identity check" });
    expect(out).toMatchObject({ scenarioId: SC_FLAKY, trial: 2, passed: false });
  });
  it("an unknown scenario becomes a readable tool error that lists valid ids", async () => {
    await expect(call(buildEvalTools(sandboxCtx(), t.deps).explain_failure, { scenarioId: "sx_nope" })).rejects.toThrow(new RegExp(`Valid ids: ${SC_PASS}`));
  });
  it("a trial out of range is a readable tool error", async () => {
    await expect(call(buildEvalTools(sandboxCtx(), t.deps).get_state_diff, { scenarioId: SC_FLAKY, trial: 7 })).rejects.toThrow(/Trial 7 does not exist/);
  });
  it("explain_concept returns a static card and caps related scenarios at 8", async () => {
    const out = await call<{ topic: string; relatedScenarioIds: string[]; body: string }>(buildEvalTools(sandboxCtx(), t.deps).explain_concept, { topic: "pass_hat_k", scenarioIds: Array.from({ length: 12 }, (_, i) => `sx_${i}`) });
    expect(out.topic).toBe("pass_hat_k");
    expect(out.relatedScenarioIds).toHaveLength(8);
    expect(out.body.length).toBeGreaterThan(20);
  });
  it("every concept topic has an explainer", async () => {
    const tools = buildEvalTools(sandboxCtx(), t.deps);
    for (const topic of CONCEPT_TOPICS) expect(await call(tools.explain_concept, { topic })).toMatchObject({ topic, title: expect.any(String) });
  });
  it("suggest_prompt_patch is applyable for hosted targets and shows a diff against the current prompt", async () => {
    const out = await call<{ applyable: boolean; lines: Array<{ op: string; text: string }> }>(buildEvalTools(sandboxCtx(), t.deps).suggest_prompt_patch, { title: "Verify first", rationale: "policy r2", addition: "Verify identity before refunds." });
    expect(out.applyable).toBe(true);
    expect(out.lines).toContainEqual({ op: "+", text: "Verify identity before refunds." });
  });
  it("suggest_prompt_patch is not applyable for non-hosted targets, jobs and when the target is unknown", async () => {
    const input = { title: "Verify first", rationale: "policy r2", addition: "Verify identity before refunds." };
    expect(await call(buildEvalTools(sandboxCtx({ target: ownTarget() }), t.deps).suggest_prompt_patch, input)).toMatchObject({ applyable: false });
    expect(await call(buildEvalTools(sandboxCtx({ target: null }), t.deps).suggest_prompt_patch, input)).toMatchObject({ applyable: false });
    expect(await call(buildEvalTools(jobCtx(), t.deps).suggest_prompt_patch, input)).toMatchObject({ applyable: false });
  });
  it("the tool input schemas reject out-of-range trials and malformed run ids", () => {
    const tools = buildEvalTools(sandboxCtx(), t.deps) as unknown as Record<string, { inputSchema: { safeParse?: (v: unknown) => { success: boolean } } }>;
    const parse = (name: string, v: unknown) => tools[name].inputSchema.safeParse?.(v).success;
    expect(parse("explain_failure", { scenarioId: SC_FLAKY, trial: 0 })).toBe(false);
    expect(parse("explain_failure", { scenarioId: SC_FLAKY, trial: 11 })).toBe(false);
    expect(parse("explain_failure", { scenarioId: SC_FLAKY, trial: 1 })).toBe(true);
    expect(parse("compare_runs", { otherRunId: "../../etc/passwd" })).toBe(false);
    expect(parse("compare_runs", { otherRunId: OTHER_RUN_ID })).toBe(true);
    expect(parse("propose_rerun", { scope: "everything" })).toBe(false);
  });
});

describe("cross-kind guards", () => {
  it.each(["explain_failure", "get_trial_timeline", "get_state_diff"] as const)("%s on an audit context is a readable error", async (name) => {
    await expect(call(buildEvalTools(jobCtx(), t.deps)[name], { scenarioId: SC_FLAKY })).rejects.toThrow(/audit, not a sandbox run/);
  });
  it("compare_runs on an audit context is a readable error", async () => {
    await expect(call(buildEvalTools(jobCtx(), t.deps).compare_runs, {})).rejects.toThrow(/audit, not a sandbox run/);
  });
  it("get_finding on a sandbox context is a readable error", async () => {
    await expect(call(buildEvalTools(sandboxCtx(), t.deps).get_finding, { findingId: "F1" })).rejects.toThrow(/sandbox run, not an audit/);
  });
  it("sandbox-only proposals on an audit context are refused and create nothing", async () => {
    const tools = buildEvalTools(jobCtx(), t.deps);
    await expect(call(tools.propose_rerun, { scope: "all" })).rejects.toThrow(/only available for sandbox/);
    await expect(call(tools.propose_add_scenario, { brief: "A long enough brief", category: "boundary" })).rejects.toThrow(/only available for sandbox/);
    expect(t.store.actions.size).toBe(0);
    expect(t.sandbox.seedSuiteFromRun).not.toHaveBeenCalled();
  });
  it("audit-only proposals on a sandbox context are refused", async () => {
    await expect(call(buildEvalTools(sandboxCtx(), t.deps).propose_rerun_finding, { findingId: "F1" })).rejects.toThrow(/only available for audits/);
  });
});

describe("compare_runs", () => {
  const listed = (over: Array<Partial<{ runId: string; name: string; status: string }>>) =>
    over.map((o) => ({ runId: OTHER_RUN_ID, name: "Acme support agent", status: "complete", ...o }));

  it("compares with an explicitly requested run owned by the caller", async () => {
    t.sandbox.getRunReport.mockResolvedValueOnce(makeReport({}, { runId: OTHER_RUN_ID, name: "v2" }));
    const out = await call<{ other: { runId: string }; rows: unknown[] }>(buildEvalTools(sandboxCtx(), t.deps).compare_runs, { otherRunId: OTHER_RUN_ID });
    expect(t.sandbox.getRunReport).toHaveBeenCalledWith(OWNER, OTHER_RUN_ID);
    expect(out.other.runId).toBe(OTHER_RUN_ID);
    expect(out.rows).toHaveLength(3);
  });
  it("a run that is not in the caller's account reads as 'not found'", async () => {
    t.sandbox.getRunReport.mockResolvedValueOnce(null);
    await expect(call(buildEvalTools(sandboxCtx(), t.deps).compare_runs, { otherRunId: OTHER_RUN_ID })).rejects.toThrow(/not found in your account/);
  });
  it("comparing a run with itself is refused", async () => {
    await expect(call(buildEvalTools(sandboxCtx(), t.deps).compare_runs, { otherRunId: RUN_ID })).rejects.toThrow(/no other run/);
  });
  it("by default picks the latest completed run of the same agent, skipping itself and unfinished runs", async () => {
    t.sandbox.listRuns.mockResolvedValue(listed([
      { runId: RUN_ID }, { runId: "run_55555555-5555-4555-8555-555555555555", status: "running" },
      { runId: "run_66666666-6666-4666-8666-666666666666", name: "Other agent" }, { runId: OTHER_RUN_ID },
    ]));
    t.sandbox.getRunReport.mockResolvedValue(makeReport({}, { runId: OTHER_RUN_ID }));
    await call(buildEvalTools(sandboxCtx(), t.deps).compare_runs, {});
    expect(t.sandbox.getRunReport).toHaveBeenCalledWith(OWNER, OTHER_RUN_ID);
  });
  it("matches a model-variant sibling run by name prefix", async () => {
    const sibling = "run_77777777-7777-4777-8777-777777777777";
    t.sandbox.listRuns.mockResolvedValue(listed([{ runId: "run_66666666-6666-4666-8666-666666666666", name: "Unrelated" }, { runId: sibling, name: "Acme support agent (openai/gpt-5-nano)" }]));
    t.sandbox.getRunReport.mockResolvedValue(makeReport({}, { runId: sibling }));
    await call(buildEvalTools(sandboxCtx(), t.deps).compare_runs, {});
    expect(t.sandbox.getRunReport).toHaveBeenCalledWith(OWNER, sibling);
  });
  it("with no other completed run, says so", async () => {
    t.sandbox.listRuns.mockResolvedValue(listed([{ runId: RUN_ID }, { status: "failed" }]));
    await expect(call(buildEvalTools(sandboxCtx(), t.deps).compare_runs, {})).rejects.toThrow(/no other run to compare/);
  });
  it("unexpected failures surface a generic message, not internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.sandbox.listRuns.mockRejectedValue(new Error("pg: password authentication failed for user admin"));
    const err = await call(buildEvalTools(sandboxCtx(), t.deps).compare_runs, {}).catch((e: unknown) => e as Error);
    expect(err.message).toBe("That lookup failed. Try again.");
  });
});

describe("propose tools", () => {
  it("propose_rerun returns a card, stores the action, and starts nothing", async () => {
    const out = await call<{ actionId: string; scenarioIds: string[] }>(buildEvalTools(sandboxCtx(), t.deps).propose_rerun, { scope: "failed", k: 3 });
    expect(out.scenarioIds).toEqual([SC_FLAKY, SC_POLICY]);
    expect(t.store.actions.get(out.actionId)).toMatchObject({ ownerId: OWNER, evalId: RUN_ID, kind: "rerun", status: "proposed", payload: { k: 3 } });
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
    expect(t.sandbox.seedSuiteFromRun).not.toHaveBeenCalled();
  });
  it("propose_rerun surfaces the allowlist error to the model", async () => {
    await expect(call(buildEvalTools(sandboxCtx(), t.deps).propose_rerun, { scope: "all", model: "evil/model" })).rejects.toThrow(/not available for hosted runs/);
  });
  it("propose_add_scenario seeds a draft and stores the proposal for the bound run", async () => {
    const out = await call<{ actionId: string; draftId: string }>(buildEvalTools(sandboxCtx(), t.deps).propose_add_scenario, { brief: "Customer asks twice for a refund", category: "adversarial_user" });
    expect(out.draftId).toBe("drf_1");
    expect(t.sandbox.seedSuiteFromRun).toHaveBeenCalledWith(OWNER, RUN_ID, expect.objectContaining({ brief: expect.objectContaining({ category: "adversarial_user" }) }));
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
  });
  it("propose_share on a sandbox run says it is not shareable", async () => {
    expect(await call(buildEvalTools(sandboxCtx(), t.deps).propose_share)).toMatchObject({ shareable: false });
  });
  it("propose_share and propose_rerun_finding on a delivered audit store proposals without side effects", async () => {
    const tools = buildEvalTools(jobCtx(), t.deps);
    await call(tools.propose_share);
    await call(tools.propose_rerun_finding, { findingId: "F2" });
    expect(t.jobs.enableShare).not.toHaveBeenCalled();
    expect(t.jobs.rerunFinding).not.toHaveBeenCalled();
    expect([...t.store.actions.values()].map((a) => a.status).sort()).toEqual(["proposed", "proposed"]);
  });
});
