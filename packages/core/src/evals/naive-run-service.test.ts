import { describe, expect, it, vi } from "vitest";
import { makeSuite } from "./text/__tests__/fixtures";
import { projectFrozenTextSuite, type RetainedTextRun, type TextContractScope } from "./naive-contract-mapping";
import { createNaiveRunService, type AuthorizedNaiveTextRun } from "./naive-run-service";
import type { TextCheckpointStore, CheckpointKey, CheckpointLookup, CheckpointValue } from "./integration/checkpoints";
import type { ServiceContext } from "../contracts/services";
import { freezeSuite } from "./text/freeze";
function store(): TextCheckpointStore {
  const rows = new Map<string, { key: CheckpointKey; state: CheckpointValue }>();
  const name = (k: CheckpointLookup) => `${k.jobId}:${k.kind}:${k.id}`;
  const get = (k: CheckpointLookup) => { const r = rows.get(name(k)); if (r && k.inputDigest && r.key.inputDigest !== k.inputDigest) throw Error("conflict"); return r; };
  return {
    async claim(k) { const r = get(k); if (r) return structuredClone(r.state); rows.set(name(k), { key: k, state: { state: "pending" } }); return { state: "claimed", token: "token" }; },
    async get(k) { return structuredClone(get(k)?.state ?? null); },
    async complete(k, _token, value) { if (!get(k)) throw Error(); rows.set(name(k), { key: k, state: { state: "completed", value: structuredClone(value) } }); },
    async release(k) { rows.delete(name(k)); },
    async markAmbiguous(k) { rows.set(name(k), { key: k, state: { state: "ambiguous" } }); },
  };
}
function setup(rubric = false) {
  const jobId = "123e4567-e89b-42d3-a456-426614174000";
  let frozen = makeSuite({ jobId });
  if (rubric) { const { digest: _, ...body } = structuredClone(frozen); body.referenceText = "The reference says the required response is READY."; body.scenarios[0]!.rubricChecks.push({ id: "S01.r1", kind: "rubric", description: "Reference grounding", rubric: "Assess grounding against the supplied reference.", assessesFactualCorrectness: true, requiresReference: true }); frozen = freezeSuite(body); }
  const scope: TextContractScope = { jobId, customerId: "customer", environment: "test", suiteDigest: frozen.digest, approvalArtifactId: "approval" };
  const projection = projectFrozenTextSuite(frozen, scope);
  const send = vi.fn(async () => ({ ok: true as const, text: "READY", latencyMs: 1 }));
  const canonicalTarget = { url: "https://target.example/api", model: "model-1", apiKey: "private-target-key", systemPrompt: frozen.systemPrompt! };
  const authority: AuthorizedNaiveTextRun = { job: { jobId, customerId: "customer", package: "text_eval", environment: "test", quoteVersion: null, linkedRetestOf: null, isFixture: true }, scope, retained: projection.retained,
    canonicalTarget, runId: "run-1", targetVersion: "target-version-1", target: { send }, judge: null };
  const saved: RetainedTextRun[] = []; const persist = vi.fn(async (_ctx, artifact: RetainedTextRun) => { saved.push(artifact); });
  const runner = { run: vi.fn(async () => { throw Error("unexpected agent call"); }) };
  const ctx: ServiceContext = { jobId, environment: "test", budgetMicroUsd: 1_000_000, recordCost: vi.fn(), recordProgress: vi.fn() };
  const service = createNaiveRunService({ runner, checkpoints: store(), resolve: async () => authority, persistRun: persist });
  return { authority, projection, send, saved, persist, ctx, service, runner, canonicalTarget };
}
describe("Naive contract run service", () => {
  it("executes authorized target once, retains full run before returning, and resumes after lost publication", async () => {
    const f = setup(); f.persist.mockRejectedValueOnce(Error("storage unavailable"));
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow("storage unavailable");
    expect(f.send).toHaveBeenCalledTimes(12);
    const result = await f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget);
    expect(result.results).toHaveLength(12); expect(f.send).toHaveBeenCalledTimes(12);
    expect(f.saved[0]!.run.executions[0]!.responseText).toBe("READY");
    expect(f.runner.run).not.toHaveBeenCalled();
  });
  it.each(["url", "model", "apiKey", "systemPrompt"] as const)("refuses request-selected %s before dispatch", async field => {
    const f = setup(); await expect(f.service.runSuite(f.ctx, f.projection.suite, { ...f.canonicalTarget, [field]: "different" })).rejects.toThrow("identity mismatch"); expect(f.send).not.toHaveBeenCalled();
  });
  it("refuses tampered public suite, cross-customer scope, branch connection and zero budget", async () => {
    const f = setup(); const edited = structuredClone(f.projection.suite); edited.scenarios[0]!.input = "changed";
    await expect(f.service.runSuite(f.ctx, edited, f.canonicalTarget)).rejects.toThrow();
    f.authority.scope.customerId = "other";
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow();
    f.authority.scope.customerId = "customer";
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget, "secret-connection")).rejects.toThrow();
    await expect(f.service.runSuite({ ...f.ctx, budgetMicroUsd: 0 }, f.projection.suite, f.canonicalTarget)).rejects.toThrow("positive authorized budget");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("retains nonboolean rubric states then refuses lossy public projection", async () => {
    const f = setup(true); await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow("cannot represent");
    expect(f.saved).toHaveLength(1); expect(f.saved[0]!.run.executions[0]!.checks.some(c => c.kind === "rubric")).toBe(true);
  });
  it("current authority revocation during a run prevents further target dispatch", async () => {
    const f = setup(); f.send.mockImplementationOnce(async () => { f.authority.scope.approvalArtifactId = "revoked"; return { ok: true, text: "READY", latencyMs: 1 }; });
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.saved).toHaveLength(0);
  });
  it("rechecks authority after persistence and refuses publication", async () => {
    const f = setup(); f.persist.mockImplementationOnce(async (_ctx, artifact) => { f.saved.push(artifact); f.authority.scope.approvalArtifactId = "revoked"; });
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow();
    expect(f.saved).toHaveLength(1);
  });
  it("screens the canonical target key even when owner knownSecrets omits it", async () => {
    const f = setup(); f.send.mockResolvedValue({ ok: true, text: f.canonicalTarget.apiKey, latencyMs: 1 });
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow();
    expect(JSON.stringify(f.saved)).not.toContain(f.canonicalTarget.apiKey);
  });
  it("rejects malformed or too-short known secret configuration before dispatch", async () => {
    const f = setup(); f.authority.knownSecrets = ["abc"];
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow();
    f.authority.knownSecrets = "private" as unknown as string[];
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not redispatch completed work under a changed target identity", async () => {
    const f = setup(); await f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget); f.authority.targetVersion = "different";
    await expect(f.service.runSuite(f.ctx, f.projection.suite, f.canonicalTarget)).rejects.toThrow("conflict");
    expect(f.send).toHaveBeenCalledTimes(12);
  });
});
