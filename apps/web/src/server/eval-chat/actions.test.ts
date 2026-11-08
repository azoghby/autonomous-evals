import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_TARGET_MODELS } from "@/components/sandbox/contract";
import type { EvalUIMessage } from "@/lib/eval-chat/types";
import {
  ACTION_TTL_MS, ActionError, actionStates, decideAction, estimate, proposeAddScenario, proposeRerun, proposeRerunFinding, proposeShare,
} from "./actions";
import { GroundingError } from "./grounding";
import {
  JOB_ID, OTHER_OWNER, OTHER_RUN_ID, OWNER, RUN_ID, SC_FLAKY, SC_PASS, SC_POLICY, jobCtx, makeDeps, makeReport, ownTarget, sandboxCtx, scenarioResult,
} from "./fixtures.testing";

const msg = (id: string, text: string): EvalUIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const ref = { kind: "sandbox_run" as const, id: RUN_ID };

let t: ReturnType<typeof makeDeps>;
let clock: Date;
beforeEach(() => {
  clock = new Date("2026-06-02T00:00:00Z");
  t = makeDeps(() => clock);
});
afterEach(() => vi.restoreAllMocks());

describe("owner and eval isolation", () => {
  it("memory store never returns another owner's messages for the same eval", async () => {
    await t.store.saveMessages(OWNER, ref, [msg("m1", "mine")]);
    expect(await t.store.loadMessages(OTHER_OWNER, ref)).toEqual([]);
    expect((await t.store.loadMessages(OWNER, ref)).map((m) => m.id)).toEqual(["m1"]);
  });
  it("memory store keeps different evals' threads apart", async () => {
    await t.store.saveMessages(OWNER, ref, [msg("m1", "mine")]);
    expect(await t.store.loadMessages(OWNER, { kind: "sandbox_run", id: OTHER_RUN_ID })).toEqual([]);
    expect(await t.store.loadMessages(OWNER, { kind: "job", id: RUN_ID })).toEqual([]);
  });
  it("another owner cannot overwrite a message by reusing its id", async () => {
    await t.store.saveMessages(OWNER, ref, [msg("m1", "original")]);
    await t.store.saveMessages(OTHER_OWNER, ref, [msg("m1", "hijacked")]);
    const [m] = await t.store.loadMessages(OWNER, ref);
    expect(m.parts[0]).toMatchObject({ text: "original" });
    expect(await t.store.loadMessages(OTHER_OWNER, ref)).toEqual([]);
  });
  it("memory store never returns another owner's actions", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "failed" });
    expect(await t.store.getAction(OTHER_OWNER, ref, card.actionId)).toBeNull();
    expect(await t.store.listActions(OTHER_OWNER, ref)).toEqual([]);
    expect(await actionStates(t.store, OTHER_OWNER, ref)).toEqual({});
    expect(Object.keys(await actionStates(t.store, OWNER, ref))).toEqual([card.actionId]);
  });
  it("decideAction with a different owner's context is a 404 ActionError and executes nothing", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "failed" });
    const err = await decideAction(t.deps, sandboxCtx({ ownerId: OTHER_OWNER }), card.actionId, "confirm").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err).toMatchObject({ status: 404 });
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
    expect(t.store.actions.get(card.actionId)!.status).toBe("proposed");
  });
  it("an action created for eval A cannot be decided from eval B's context", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "failed" });
    const evalB = sandboxCtx({ ref: { kind: "sandbox_run", id: OTHER_RUN_ID }, report: makeReport({}, { runId: OTHER_RUN_ID }) });
    await expect(decideAction(t.deps, evalB, card.actionId, "confirm")).rejects.toMatchObject({ status: 404 });
    expect(t.sandbox.seedSuiteFromRun).not.toHaveBeenCalled();
  });
  it("an action created for a run cannot be decided from a job context (kind mismatch)", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "failed" });
    await expect(decideAction(t.deps, jobCtx(), card.actionId, "cancel")).rejects.toMatchObject({ status: 404 });
  });
  it("unknown action id is a 404", async () => {
    await expect(decideAction(t.deps, sandboxCtx(), "act_nope", "confirm")).rejects.toMatchObject({ status: 404, name: "ActionError" });
  });
});

describe("propose_rerun", () => {
  it("scope failed selects only scenarios with a failed trial, and calls nothing", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "failed" });
    expect(card).toMatchObject({ kind: "rerun", status: "proposed", scope: "failed", scenarioIds: [SC_FLAKY, SC_POLICY], k: 2, model: null, promptChanged: false });
    expect(t.sandbox.seedSuiteFromRun).not.toHaveBeenCalled();
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
  });
  it("scope all selects every scenario; scope selected resolves titles to ids and de-duplicates", async () => {
    expect((await proposeRerun(t.deps, sandboxCtx(), { scope: "all" })).scenarioIds).toEqual([SC_PASS, SC_FLAKY, SC_POLICY]);
    const sel = await proposeRerun(t.deps, sandboxCtx(), { scope: "selected", scenarioIds: ["Refund past the window", SC_POLICY] });
    expect(sel.scenarioIds).toEqual([SC_POLICY]);
  });
  it("selected with an unknown scenario throws a GroundingError; with none throws a 400 ActionError", async () => {
    await expect(proposeRerun(t.deps, sandboxCtx(), { scope: "selected", scenarioIds: ["sx_zzz"] })).rejects.toBeInstanceOf(GroundingError);
    await expect(proposeRerun(t.deps, sandboxCtx(), { scope: "selected" })).rejects.toMatchObject({ status: 400 });
  });
  it("scope failed on a run where nothing failed is an ActionError", async () => {
    const r = makeReport();
    r.results = r.results.map((x) => scenarioResult(x.scenarioId, x.trials.map((tr) => ({ ...tr, passed: true }))));
    await expect(proposeRerun(t.deps, sandboxCtx({ report: r }), { scope: "failed" })).rejects.toThrow(/Nothing failed/);
  });
  it("clamps k to 1..10 and defaults to the run's k", async () => {
    expect((await proposeRerun(t.deps, sandboxCtx(), { scope: "all", k: 99 })).k).toBe(10);
    expect((await proposeRerun(t.deps, sandboxCtx(), { scope: "all", k: 0 })).k).toBe(1);
    expect((await proposeRerun(t.deps, sandboxCtx(), { scope: "all", k: 2.9 })).k).toBe(2);
  });
  it("estimates cost from the run's average per-trial spend", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "failed", k: 3 });
    // $0.06 over 6 trials = $0.01 per trial; 2 scenarios x k=3 = 6 trials.
    expect(card.estimate).toMatchObject({ trials: 6, perTrialUsd: 0.01, totalUsd: 0.06 });
    expect(card.estimate.basis).toContain("averaged");
    expect(card.estimate.budgetUsd).toBeGreaterThan(0);
  });
  it("falls back to a typical per-trial cost when the run has no recorded spend", () => {
    const e = estimate(makeReport({ costMicroUsd: 0 }), 4);
    expect(e).toMatchObject({ perTrialUsd: 0.05, totalUsd: 0.2 });
    expect(e.basis).toMatch(/No spend recorded/);
  });
  it("expires the proposal 30 minutes after creation", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "all" });
    expect(new Date(card.expiresAt).getTime()).toBe(clock.getTime() + ACTION_TTL_MS);
  });
  it("rejects the sample report (read-only)", async () => {
    await expect(proposeRerun(t.deps, sandboxCtx({ report: makeReport({ sample: true }) }), { scope: "all" })).rejects.toBeInstanceOf(ActionError);
  });
  it.each(["queued", "running"] as const)("rejects a run that is still %s", async (status) => {
    await expect(proposeRerun(t.deps, sandboxCtx({ report: makeReport({ status }) }), { scope: "all" })).rejects.toThrow(/still in progress/);
  });
  it("rejects a model outside the hosted allowlist and lists the allowed ones", async () => {
    const err = await proposeRerun(t.deps, sandboxCtx(), { scope: "all", model: "openai/gpt-9" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    for (const m of GATEWAY_TARGET_MODELS) expect((err as Error).message).toContain(m);
  });
  it("accepts an allowlisted model and records the current model", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "all", model: "openai/gpt-5-nano", systemPrompt: "new" });
    expect(card).toMatchObject({ model: "openai/gpt-5-nano", currentModel: "openai/gpt-5-mini", promptChanged: true });
  });
  it("rejects a model or prompt change for non-hosted targets and for unknown targets", async () => {
    await expect(proposeRerun(t.deps, sandboxCtx({ target: ownTarget() }), { scope: "all", model: "openai/gpt-5-mini" })).rejects.toThrow(/only be changed for hosted/);
    await expect(proposeRerun(t.deps, sandboxCtx({ target: ownTarget() }), { scope: "all", systemPrompt: "x" })).rejects.toBeInstanceOf(ActionError);
    await expect(proposeRerun(t.deps, sandboxCtx({ target: null }), { scope: "all", model: "openai/gpt-5-mini" })).rejects.toBeInstanceOf(ActionError);
  });
  it("a plain re-run (no model/prompt) is allowed on a non-hosted target", async () => {
    expect((await proposeRerun(t.deps, sandboxCtx({ target: ownTarget() }), { scope: "failed" })).currentModel).toBeNull();
  });
  it("is sandbox-only", async () => {
    await expect(proposeRerun(t.deps, jobCtx(), { scope: "all" })).rejects.toThrow(/only available for sandbox/);
  });
});

describe("propose_add_scenario", () => {
  it("seeds a generating draft (the one write allowed before confirm) but never starts a run", async () => {
    const card = await proposeAddScenario(t.deps, sandboxCtx(), { brief: "Customer asks for refund over limit", category: "boundary" });
    expect(t.sandbox.seedSuiteFromRun).toHaveBeenCalledWith(OWNER, RUN_ID, { brief: { brief: "Customer asks for refund over limit", category: "boundary" } });
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
    expect(card).toMatchObject({ kind: "add_scenario", status: "proposed", draftId: "drf_1", scope: "new", k: 1, replacesScenarioId: null, baseScenarioIds: [SC_PASS, SC_FLAKY, SC_POLICY] });
    expect(card.estimate.trials).toBe(1);
  });
  it("replacing a scenario removes it from the base set and passes removeScenarioIds", async () => {
    const card = await proposeAddScenario(t.deps, sandboxCtx(), { brief: "A better refund scenario", category: "happy_path", replaceScenarioId: "Refund past the window", k: 2 });
    expect(t.sandbox.seedSuiteFromRun).toHaveBeenCalledWith(OWNER, RUN_ID, expect.objectContaining({ removeScenarioIds: [SC_POLICY] }));
    expect(card.replacesScenarioId).toBe(SC_POLICY);
    expect(card.baseScenarioIds).toEqual([SC_PASS, SC_FLAKY]);
  });
  it("scope all estimates every base scenario plus the new one", async () => {
    const card = await proposeAddScenario(t.deps, sandboxCtx(), { brief: "Another refund scenario", category: "happy_path", scope: "all", k: 2 });
    expect(card.estimate.trials).toBe(8);
  });
  it("rejects a too-short brief with 400 before seeding anything", async () => {
    await expect(proposeAddScenario(t.deps, sandboxCtx(), { brief: "  short ", category: "boundary" })).rejects.toMatchObject({ status: 400 });
    expect(t.sandbox.seedSuiteFromRun).not.toHaveBeenCalled();
  });
  it("a missing run (service returns null) is a 404 ActionError", async () => {
    t.sandbox.seedSuiteFromRun.mockResolvedValueOnce(null);
    await expect(proposeAddScenario(t.deps, sandboxCtx(), { brief: "Valid brief here", category: "boundary" })).rejects.toMatchObject({ status: 404 });
  });
  it("rejects the sample report without seeding", async () => {
    await expect(proposeAddScenario(t.deps, sandboxCtx({ report: makeReport({ sample: true }) }), { brief: "Valid brief here", category: "boundary" })).rejects.toBeInstanceOf(ActionError);
    expect(t.sandbox.seedSuiteFromRun).not.toHaveBeenCalled();
  });
});

describe("propose_share", () => {
  it("sandbox runs are not shareable: card is cancelled, nothing is enabled, and the stored action is cancelled", async () => {
    const card = await proposeShare(t.deps, sandboxCtx());
    expect(card).toMatchObject({ kind: "share_report", shareable: false, status: "cancelled" });
    expect(card.reason).toMatch(/private/);
    expect(t.jobs.enableShare).not.toHaveBeenCalled();
    expect(t.store.actions.get(card.actionId)!.status).toBe("cancelled");
    const after = await decideAction(t.deps, sandboxCtx(), card.actionId, "confirm");
    expect(after.status).toBe("cancelled");
    expect(t.jobs.enableShare).not.toHaveBeenCalled();
  });
  it("delivered audits get download links and a shareable proposal that has not enabled sharing", async () => {
    const card = await proposeShare(t.deps, jobCtx());
    expect(card).toMatchObject({ shareable: true, status: "proposed", reason: null });
    expect(card.downloads.map((d) => d.href)).toContain(`/api/jobs/${JOB_ID}/artifacts/report`);
    expect(card.downloads).toHaveLength(4);
    expect(t.jobs.enableShare).not.toHaveBeenCalled();
  });
  it("undelivered audits are not shareable and have no downloads", async () => {
    expect(await proposeShare(t.deps, jobCtx({ state: "running" }))).toMatchObject({ shareable: false, downloads: [] });
  });
});

describe("propose_rerun_finding", () => {
  it("creates a proposal for a delivered audit without re-running", async () => {
    const card = await proposeRerunFinding(t.deps, jobCtx(), { findingId: "Leaks customer" });
    expect(card).toMatchObject({ kind: "rerun_finding", findingId: "f-row-1", title: "Leaks customer email" });
    expect(t.jobs.rerunFinding).not.toHaveBeenCalled();
  });
  it("is refused before delivery, for unknown findings, and for sandbox runs", async () => {
    await expect(proposeRerunFinding(t.deps, jobCtx({ state: "running" }), { findingId: "F1" })).rejects.toThrow(/once the audit is delivered/);
    await expect(proposeRerunFinding(t.deps, jobCtx(), { findingId: "zzz" })).rejects.toBeInstanceOf(GroundingError);
    await expect(proposeRerunFinding(t.deps, sandboxCtx(), { findingId: "F1" })).rejects.toThrow(/only available for audits/);
  });
});

describe("decideAction: confirm executes the stored payload", () => {
  it("rerun: seeds a suite minus the unselected scenarios and starts a run with the stored k and scenario ids", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed", k: 3 });
    const res = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.sandbox.seedSuiteFromRun).toHaveBeenCalledWith(OWNER, RUN_ID, { removeScenarioIds: [SC_PASS] });
    expect(t.sandbox.startRun).toHaveBeenCalledTimes(1);
    expect(t.sandbox.startRun).toHaveBeenCalledWith(OWNER, "drf_1", { k: 3, scenarioIds: [SC_FLAKY, SC_POLICY] });
    expect(res).toEqual({ actionId: card.actionId, status: "executed", runId: "run_new", runUrl: "/sandbox/runs/run_new" });
    expect(t.store.actions.get(card.actionId)).toMatchObject({ status: "executed", result: { runId: "run_new", runUrl: "/sandbox/runs/run_new" } });
  });
  it("rerun with model and prompt passes the stored target to the service", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "all", model: "openai/gpt-5-nano", systemPrompt: "Be strict." });
    await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.sandbox.seedSuiteFromRun).toHaveBeenCalledWith(OWNER, RUN_ID, { removeScenarioIds: [], target: { model: "openai/gpt-5-nano", systemPrompt: "Be strict." } });
  });
  it("uses the stored payload even if the stored row is the only source of k and scenarios", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "selected", scenarioIds: [SC_PASS], k: 4 });
    // A confirm carries no parameters at all: only the action id and a decision exist on the API.
    expect(decideAction.length).toBe(4);
    await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.sandbox.startRun).toHaveBeenCalledWith(OWNER, "drf_1", { k: 4, scenarioIds: [SC_PASS] });
  });
  it("a second confirm does not execute again and returns the executed state with the run id", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed" });
    await decideAction(t.deps, ctx, card.actionId, "confirm");
    const again = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.sandbox.startRun).toHaveBeenCalledTimes(1);
    expect(t.sandbox.seedSuiteFromRun).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ status: "executed", runId: "run_new" });
  });
  it("two simultaneous confirms execute exactly once (compare-and-set)", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed" });
    const [a, b] = await Promise.all([decideAction(t.deps, ctx, card.actionId, "confirm"), decideAction(t.deps, ctx, card.actionId, "confirm")]);
    expect(t.sandbox.startRun).toHaveBeenCalledTimes(1);
    expect([a.status, b.status]).toContain("executed");
  });
  it("cancel then confirm stays cancelled and executes nothing", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed" });
    expect((await decideAction(t.deps, ctx, card.actionId, "cancel")).status).toBe("cancelled");
    expect((await decideAction(t.deps, ctx, card.actionId, "confirm")).status).toBe("cancelled");
    expect(t.sandbox.seedSuiteFromRun).not.toHaveBeenCalled();
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
  });
  it("confirm then cancel does not undo the execution", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed" });
    await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect((await decideAction(t.deps, ctx, card.actionId, "cancel")).status).toBe("executed");
  });
  it("an expired proposal becomes expired with a message and nothing executes", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed" });
    clock = new Date(clock.getTime() + ACTION_TTL_MS + 1);
    const res = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(res).toMatchObject({ status: "expired" });
    expect(res.error).toMatch(/expired/);
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
    expect(t.store.actions.get(card.actionId)!.status).toBe("expired");
  });
  it("expired proposals also show as expired when a thread rehydrates, before anyone decides", async () => {
    const card = await proposeRerun(t.deps, sandboxCtx(), { scope: "failed" });
    const later = new Date(clock.getTime() + ACTION_TTL_MS + 1);
    expect((await actionStates(t.store, OWNER, ref, later))[card.actionId].status).toBe("expired");
    expect((await actionStates(t.store, OWNER, ref, clock))[card.actionId].status).toBe("proposed");
  });
  it("an unexpected service error fails the action with a generic message and no internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.sandbox.startRun.mockRejectedValueOnce(new Error("connection string postgres://secret"));
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed" });
    const res = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(res).toMatchObject({ status: "failed", error: "Could not complete that action. Try again." });
    expect(JSON.stringify(res)).not.toContain("postgres");
  });
  it("startRun returning 402 fails the action with that error", async () => {
    t.sandbox.startRun.mockResolvedValueOnce({ ok: false, status: 402, error: "Monthly trial limit reached. See /pricing." });
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed" });
    const res = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(res).toMatchObject({ status: "failed", error: "Monthly trial limit reached. See /pricing." });
    expect(t.store.actions.get(card.actionId)).toMatchObject({ status: "failed", result: { error: "Monthly trial limit reached. See /pricing." } });
  });
  it("a service that no longer finds the run fails the action with a 404 message", async () => {
    const ctx = sandboxCtx();
    const card = await proposeRerun(t.deps, ctx, { scope: "failed" });
    t.sandbox.seedSuiteFromRun.mockResolvedValueOnce(null);
    expect(await decideAction(t.deps, ctx, card.actionId, "confirm")).toMatchObject({ status: "failed", error: "Run not found." });
  });
});

describe("decideAction: add_scenario", () => {
  const propose = (ctx = sandboxCtx(), extra: Partial<Parameters<typeof proposeAddScenario>[2]> = {}) =>
    proposeAddScenario(t.deps, ctx, { brief: "Customer asks for refund over limit", category: "boundary", k: 2, ...extra });

  it("while the draft is still generating, the proposal stays open with a clear message and nothing runs", async () => {
    t.sandbox.getDraft.mockResolvedValue(t.draft("generating"));
    const ctx = sandboxCtx();
    const card = await propose(ctx);
    const res = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(res).toMatchObject({ status: "proposed" });
    expect(res.error).toMatch(/still being generated/);
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
  });
  it("a retry after the draft becomes ready runs the scenario", async () => {
    t.sandbox.getDraft.mockResolvedValueOnce(t.draft("generating"));
    const ctx = sandboxCtx();
    const card = await propose(ctx);
    await decideAction(t.deps, ctx, card.actionId, "confirm");
    t.sandbox.getDraft.mockResolvedValue(t.draft("ready", ["sx_new_1"]));
    await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.sandbox.startRun).toHaveBeenCalledTimes(1);
  });
  it("when ready with a validated new scenario, starts a run with only the new scenario id (scope new) and the stored k", async () => {
    const ctx = sandboxCtx();
    const card = await propose(ctx);
    const res = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.sandbox.startRun).toHaveBeenCalledWith(OWNER, "drf_1", { k: 2, scenarioIds: ["sx_new_1"] });
    expect(res).toMatchObject({ status: "executed", runId: "run_new" });
  });
  it("scope all re-runs the base scenarios plus the validated new one", async () => {
    const ctx = sandboxCtx();
    const card = await propose(ctx, { scope: "all" });
    await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.sandbox.startRun).toHaveBeenCalledWith(OWNER, "drf_1", { k: 2, scenarioIds: [SC_PASS, SC_FLAKY, SC_POLICY, "sx_new_1"] });
  });
  it("a new scenario that failed the gates is not run", async () => {
    t.sandbox.getDraft.mockResolvedValue(t.draft("ready", ["sx_new_1"], false));
    const ctx = sandboxCtx();
    const card = await propose(ctx);
    expect(await decideAction(t.deps, ctx, card.actionId, "confirm")).toMatchObject({ status: "failed", error: expect.stringMatching(/did not pass the gates/) });
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
  });
  it("a draft whose generation failed reports the reason", async () => {
    t.sandbox.getDraft.mockResolvedValue(t.draft("failed"));
    const ctx = sandboxCtx();
    const card = await propose(ctx);
    expect((await decideAction(t.deps, ctx, card.actionId, "confirm")).error).toContain("gate exploded");
  });
  it("a missing draft fails with 'gone'", async () => {
    t.sandbox.getDraft.mockResolvedValue(null);
    const ctx = sandboxCtx();
    const card = await propose(ctx);
    expect((await decideAction(t.deps, ctx, card.actionId, "confirm")).error).toMatch(/gone/);
  });
  it("a draft that never produced a new scenario is not run", async () => {
    t.sandbox.getDraft.mockResolvedValue(t.draft("ready"));
    const ctx = sandboxCtx();
    const card = await propose(ctx);
    expect((await decideAction(t.deps, ctx, card.actionId, "confirm")).status).toBe("failed");
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
  });
});

describe("decideAction: audits", () => {
  it("share: returns shareUrl in the response but the stored result has no URL or token", async () => {
    const ctx = jobCtx();
    const card = await proposeShare(t.deps, ctx);
    const res = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.jobs.enableShare).toHaveBeenCalledWith(JOB_ID);
    expect(res).toMatchObject({ status: "executed", shareUrl: "https://app.example/share/SECRET-TOKEN" });
    const stored = t.store.actions.get(card.actionId)!;
    expect(stored.result).toEqual({ shared: true });
    expect(JSON.stringify(stored)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(await actionStates(t.store, OWNER, ctx.ref))).not.toContain("SECRET-TOKEN");
  });
  it("share: a second confirm does not mint another link or return one", async () => {
    const ctx = jobCtx();
    const card = await proposeShare(t.deps, ctx);
    await decideAction(t.deps, ctx, card.actionId, "confirm");
    const again = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.jobs.enableShare).toHaveBeenCalledTimes(1);
    expect(again.shareUrl).toBeUndefined();
    expect(again.status).toBe("executed");
  });
  it("share: a job that is no longer delivered at confirm time fails without enabling the link", async () => {
    const card = await proposeShare(t.deps, jobCtx());
    const res = await decideAction(t.deps, jobCtx({ state: "running" }), card.actionId, "confirm");
    expect(res).toMatchObject({ status: "failed", error: expect.stringMatching(/Only delivered/) });
    expect(t.jobs.enableShare).not.toHaveBeenCalled();
  });
  it("rerun_finding: calls the job port with the audit data and the stored finding id", async () => {
    const ctx = jobCtx();
    const card = await proposeRerunFinding(t.deps, ctx, { findingId: "Leaks customer" });
    const res = await decideAction(t.deps, ctx, card.actionId, "confirm");
    expect(t.jobs.rerunFinding).toHaveBeenCalledWith(ctx.job, "f-row-1");
    expect(res.status).toBe("executed");
    expect(t.store.actions.get(card.actionId)!.result).toEqual({ rerunStarted: true });
  });
  it("rerun_finding: a rejected re-run fails the action with the port's error", async () => {
    t.jobs.rerunFinding.mockResolvedValueOnce({ ok: false, status: 429, error: "Too many re-runs" });
    const ctx = jobCtx();
    const card = await proposeRerunFinding(t.deps, ctx, { findingId: "F1" });
    expect(await decideAction(t.deps, ctx, card.actionId, "confirm")).toMatchObject({ status: "failed", error: "Too many re-runs" });
  });
});
