import { describe, expect, it, vi } from "vitest";
import type { IntakeInput } from "../contracts";
import type { ServiceContext } from "../contracts/services";
import type { TextDesignOutcome } from "./text/design";
import { makeSuite } from "./text/__tests__/fixtures";
import { canonicalJson } from "./text/freeze";
import { createNaiveDesignService, type AuthorizedNaiveTextDesign, type NaiveTextDesignAdmission } from "./naive-design-service";
import { projectFrozenTextSuite } from "./naive-contract-mapping";
import { TrackBBlockedError, TrackBPendingError } from "./service-adapter";
const jobId = "123e4567-e89b-42d3-a456-426614174000";
function harness() {
  const intake: IntakeInput = { package: "text_eval", authorizedToTest: true, endpoint: { url: "https://example.com/agent", model: "test-model", apiKey: "private-test-key", systemPrompt: "Follow the explicit user constraints." } };
  const auth: AuthorizedNaiveTextDesign = { job: { jobId, customerId: "customer-1", environment: "test", package: "text_eval", quoteVersion: 1, linkedRetestOf: null, isFixture: true }, intake: structuredClone(intake), designId: "initial-design", versionLabel: "v1", knownSecrets: [] };
  const frozen = makeSuite({ jobId, versionLabel: "v1", systemPrompt: intake.endpoint.systemPrompt });
  let record: NaiveTextDesignAdmission | null = null;
  let result: TextDesignOutcome = { status: "completed", suite: frozen, costs: [] };
  let denied = false;
  let afterEngine = () => {}, afterAdmit = () => {};
  const ctx: ServiceContext = { jobId, environment: "test", budgetMicroUsd: 300_000, recordCost: vi.fn(async () => {}), recordProgress: vi.fn(async () => {}) };
  const authorize = vi.fn(async () => { if (denied) throw new TrackBBlockedError("rejected_input", "Denied"); return structuredClone(auth); });
  const engine = { designSuite: vi.fn(async () => { afterEngine(); return structuredClone(result); }) };
  const admission = {
    load: vi.fn(async identity => { if (record && canonicalJson(record.identity) !== canonicalJson(identity)) throw new TrackBBlockedError("rejected_input", "Identity conflict"); return structuredClone(record); }),
    admit: vi.fn(async (identity, suite) => {
      const projection = projectFrozenTextSuite(suite, { jobId, customerId: identity.customerId, environment: identity.environment, suiteDigest: suite.digest, approvalArtifactId: "durable-approval-1" });
      record = { identity: structuredClone(identity), status: "approved", artifact: projection.retained };
      afterAdmit(); return structuredClone(record);
    }),
  } satisfies Parameters<typeof createNaiveDesignService>[0]["admission"];
  return { api: createNaiveDesignService({ authorize, engine, admission }), intake, auth, frozen, ctx, authorize, engine, admission,
    get record() { return record; }, set record(value) { record = value; }, set result(value: TextDesignOutcome) { result = value; },
    set afterEngine(fn: () => void) { afterEngine = fn; }, set afterAdmit(fn: () => void) { afterAdmit = fn; }, deny() { denied = true; } };
}
describe("Naive contract design service", () => {
  it("durably admits the exact reviewed rich suite before returning a projection", async () => {
    const f = harness(); const suite = await f.api.designSuite(f.ctx, f.intake);
    expect(suite.jobId).toBe(jobId); expect(f.admission.admit).toHaveBeenCalledOnce();
    expect(f.record?.status).toBe("approved"); if (f.record?.status !== "approved") throw Error();
    expect(f.record.artifact.frozen).toEqual(f.frozen); expect(f.record.artifact.scope.approvalArtifactId).toBe("durable-approval-1");
    expect(JSON.stringify(f.engine.designSuite.mock.calls)).not.toContain("private-test-key");
    expect(JSON.stringify(f.admission.admit.mock.calls)).not.toContain("private-test-key");
    expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it("replays the stable design through the durable engine for cost redelivery without re-admission", async () => {
    const f = harness(); const first = await f.api.designSuite(f.ctx, f.intake); const second = await f.api.designSuite(f.ctx, f.intake);
    expect(second).toEqual(first); expect(f.engine.designSuite).toHaveBeenCalledTimes(2); expect(f.admission.admit).toHaveBeenCalledOnce();
    expect(f.engine.designSuite.mock.calls[0]).toEqual(f.engine.designSuite.mock.calls[1]);
  });
  it("refuses mismatched stored intake, foreign scope and unsupported packages before dispatch", async () => {
    const f = harness(); f.auth.job.customerId = ""; await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toBeInstanceOf(TrackBBlockedError); expect(f.engine.designSuite).not.toHaveBeenCalled();
    const g = harness(); if (g.auth.intake.package !== "text_eval") throw Error(); g.auth.intake.endpoint.model = "other";
    await expect(g.api.designSuite(g.ctx, g.intake)).rejects.toBeInstanceOf(TrackBBlockedError); expect(g.engine.designSuite).not.toHaveBeenCalled();
    await expect(harness().api.designSuite(f.ctx, { package: "trace_audit", trace: "trace", authorizedToTest: true })).rejects.toBeInstanceOf(TrackBBlockedError);
  });
  it("rejects malformed current secret lists before dispatch", async () => {
    const f = harness(); f.auth.knownSecrets = [42] as unknown as string[];
    await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toMatchObject({ code: "rejected_input" });
    expect(f.engine.designSuite).not.toHaveBeenCalled();
  });
  it("rejects zero budget before any engine call", async () => {
    const f = harness(); f.ctx.budgetMicroUsd = 0; await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toMatchObject({ code: "paused_budget" }); expect(f.engine.designSuite).not.toHaveBeenCalled();
  });
  it("maps pending and budget outcomes without persisting approval", async () => {
    const f = harness(); f.result = { status: "blocked", reason: "pending", costs: [], agentOutcome: { status: "pending", taskKey: "key", reason: "session_running", sessionId: null, retryAfterMs: 1200 } };
    await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toMatchObject({ retryAfterMs: 1200 }); expect(f.admission.admit).not.toHaveBeenCalled();
    f.result = { status: "blocked", reason: "budget_exhausted", costs: [], agentOutcome: { status: "budget_exhausted", taskKey: "key", exhaustedScope: "job", capMicroUsd: 1, availableMicroUsd: 0 } };
    await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toMatchObject({ code: "paused_budget" });
    f.result = { status: "blocked", reason: "unsafe_or_invalid_draft", costs: [] }; await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toMatchObject({ code: "agent_failed" });
  });
  it("reauthorizes after engine completion and after durable admission", async () => {
    const f = harness(); f.afterEngine = () => f.deny(); await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toThrow("Denied"); expect(f.admission.admit).not.toHaveBeenCalled();
    const g = harness(); g.afterAdmit = () => g.deny(); await expect(g.api.designSuite(g.ctx, g.intake)).rejects.toThrow("Denied"); expect(g.admission.admit).toHaveBeenCalledOnce();
  });
  it("rechecks newly rotated secret refusals on completion and replay", async () => {
    const f = harness(); f.afterEngine = () => { f.auth.knownSecrets = ["Fixture 1"]; }; await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toBeInstanceOf(TrackBBlockedError); expect(f.admission.admit).not.toHaveBeenCalled();
    const g = harness(); await g.api.designSuite(g.ctx, g.intake); g.auth.knownSecrets = ["Fixture 1"]; await expect(g.api.designSuite(g.ctx, g.intake)).rejects.toBeInstanceOf(TrackBBlockedError); expect(g.engine.designSuite).toHaveBeenCalledOnce();
  });
  it("does not resurrect pending or revoked durable approval on replay", async () => {
    const f = harness(); await f.api.designSuite(f.ctx, f.intake); if (!f.record) throw Error(); f.record = { identity: f.record.identity, status: "pending" };
    await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toBeInstanceOf(TrackBPendingError); expect(f.engine.designSuite).toHaveBeenCalledOnce();
    const g = harness(); await g.api.designSuite(g.ctx, g.intake); g.afterEngine = () => { if (!g.record) throw Error(); g.record = { identity: g.record.identity, status: "rejected" }; };
    await expect(g.api.designSuite(g.ctx, g.intake)).rejects.toBeInstanceOf(TrackBBlockedError);
  });
  it("refuses mismatched engine output and failed durable publication", async () => {
    const f = harness(); f.result = { status: "completed", suite: makeSuite({ jobId, versionLabel: "wrong" }), costs: [] }; await expect(f.api.designSuite(f.ctx, f.intake)).rejects.toBeInstanceOf(TrackBBlockedError); expect(f.admission.admit).not.toHaveBeenCalled();
    const g = harness(); g.admission.admit.mockRejectedValueOnce(new Error("storage unavailable")); await expect(g.api.designSuite(g.ctx, g.intake)).rejects.toThrow("storage unavailable");
  });
});
