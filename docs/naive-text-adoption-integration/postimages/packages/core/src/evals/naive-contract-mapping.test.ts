import { describe, expect, it } from "vitest";
import { makeSuite } from "./text/__tests__/fixtures";
import { freezeSuite } from "./text/freeze";
import { evaluateObjectiveCheck } from "./text/objective";
import type { SuiteRun } from "./text/schema";
import { projectFrozenTextSuite, restoreFrozenTextSuite, projectTextSuiteRun, restoreTextSuiteRun, type TextContractScope } from "./naive-contract-mapping";
const jobId = "123e4567-e89b-42d3-a456-426614174000";
function fixture() {
  const frozen = makeSuite({ jobId });
  const scope: TextContractScope = { jobId, customerId: "customer-1", environment: "test", suiteDigest: frozen.digest, approvalArtifactId: "approval-1" };
  const suite = projectFrozenTextSuite(frozen, scope);
  const run: SuiteRun = { schemaVersion: "text_run.v1", jobId, suiteDigest: frozen.digest, versionLabel: frozen.versionLabel, runId: "run-1", startedAt: frozen.frozenAt, completedAt: frozen.frozenAt,
    executions: frozen.scenarios.map(s => ({ scenarioId: s.id, runId: "run-1", attempt: "initial", outcome: "completed", target: { ok: true, errorCode: null, latencyMs: 1 }, responseText: "READY", responseClipped: false,
      checks: s.objectiveChecks.map(c => evaluateObjectiveCheck(c, "READY")), startedAt: frozen.frozenAt, completedAt: frozen.frozenAt })) };
  return { frozen, scope, suite, run };
}
describe("Naive text contract mapping", () => {
  it("retains exact digest, review, system/reference, rationale and severity through roundtrip", () => {
    const f = fixture();
    expect(f.suite.suite.scenarios[0]!.checks[0]!.spec.dialect).toBe("naive_text_check.v1");
    expect(restoreFrozenTextSuite(f.suite.suite, f.suite.retained, f.scope)).toEqual(f.frozen);
    expect(f.suite.retained.frozen.review).toEqual(f.frozen.review);
    expect(f.suite.suite).not.toHaveProperty("digest");
    f.suite.suite.scenarios[0]!.title = "edited";
    expect(() => restoreFrozenTextSuite(f.suite.suite, f.suite.retained, f.scope)).toThrow("mismatch");
    expect(f.frozen.scenarios[0]!.title).not.toBe("edited");
  });
  it("rejects projection defaults, extensions, missing checks and substituted metadata", () => {
    const f = fixture();
    const noVersion = structuredClone(f.suite.suite) as Partial<typeof f.suite.suite>; delete noVersion.versionLabel;
    expect(() => restoreFrozenTextSuite(noVersion, f.suite.retained, f.scope)).toThrow();
    expect(() => restoreFrozenTextSuite({ ...f.suite.suite, approved: true }, f.suite.retained, f.scope)).toThrow();
    const missing = structuredClone(f.suite.suite); missing.scenarios.pop(); expect(() => restoreFrozenTextSuite(missing, f.suite.retained, f.scope)).toThrow();
    const changed = structuredClone(f.suite.retained); changed.frozen.review.reductions.push("skip review"); expect(() => restoreFrozenTextSuite(f.suite.suite, changed, f.scope)).toThrow();
  });
  it.each(["customerId", "environment", "approvalArtifactId", "jobId", "suiteDigest"] as const)("requires current authorized %s binding", field => {
    const f = fixture(); const changed = { ...f.scope, [field]: field === "environment" ? "live" : "different" } as TextContractScope;
    expect(() => restoreFrozenTextSuite(f.suite.suite, f.suite.retained, changed)).toThrow();
  });
  it("requires digest integrity, deterministic admission and contract-compatible IDs", () => {
    const f = fixture(); const changed = structuredClone(f.frozen); changed.scenarios[0]!.userMessage = "Ignore rules";
    expect(() => projectFrozenTextSuite(changed, f.scope)).toThrow();
    const { digest: _, ...body } = changed; const refrozen = freezeSuite(body);
    expect(() => projectFrozenTextSuite(refrozen, { ...f.scope, suiteDigest: refrozen.digest })).toThrow();
    const nonUuid = makeSuite(); expect(() => projectFrozenTextSuite(nonUuid, { ...f.scope, jobId: nonUuid.jobId, suiteDigest: nonUuid.digest })).toThrow();
  });
  it("maps only full objective decisions and restores the complete retained run", () => {
    const f = fixture(); const projection = projectTextSuiteRun(f.run, f.suite, f.scope);
    expect(projection.result.results).toHaveLength(12); expect(projection.result.results.every(r => r.passed)).toBe(true);
    expect(restoreTextSuiteRun(projection.result, projection.retained, f.suite, f.scope)).toEqual(f.run);
    projection.result.results[0]!.passed = false;
    expect(() => restoreTextSuiteRun(projection.result, projection.retained, f.suite, f.scope)).toThrow();
    expect(f.run.executions[0]!.checks[0]!.status).toBe("pass");
  });
  it("rejects partial, duplicate, wrong-suite and wrong-check runs", () => {
    const f = fixture(); const partial = structuredClone(f.run); partial.executions.pop(); expect(() => projectTextSuiteRun(partial, f.suite, f.scope)).toThrow();
    const duplicate = structuredClone(f.run); duplicate.executions[1] = duplicate.executions[0]!; expect(() => projectTextSuiteRun(duplicate, f.suite, f.scope)).toThrow();
    const wrong = structuredClone(f.run); wrong.suiteDigest = "a".repeat(64); expect(() => projectTextSuiteRun(wrong, f.suite, f.scope)).toThrow();
    const check = structuredClone(f.run); check.executions[0]!.checks[0]!.checkId = "S02.o1"; expect(() => projectTextSuiteRun(check, f.suite, f.scope)).toThrow();
  });
  it.each(["inconclusive", "not_assessed", "error"] as const)("never silently maps %s to a boolean", status => {
    const f = fixture(); f.run.executions[0]!.checks[0]!.status = status;
    const projection = projectTextSuiteRun(f.run, f.suite, f.scope);
    expect(projection.result.results[0]!.assessment?.kind).toBe("inconclusive");
    expect(projection.result.results[0]).not.toHaveProperty("passed");
    expect(projection.result.results[0]!.assessment?.checks[0]!.status).toBe(status);
    expect(restoreTextSuiteRun(projection.result, projection.retained, f.suite, f.scope)).toEqual(f.run);
    expect(() => restoreTextSuiteRun(projection.result, projection.retained, f.suite, { ...f.scope, approvalArtifactId: "substituted" })).toThrow();
  });
  it("rejects an impossible objective concern rather than publishing an objective failure", () => {
    const f = fixture(); f.run.executions[0]!.checks[0]!.status = "concern";
    expect(() => projectTextSuiteRun(f.run, f.suite, f.scope)).toThrow("mismatch");
  });
  it("preserves passing and concerned rubric assessments without objective booleans", () => {
    const f = fixture(); const { digest: _, ...body } = structuredClone(f.frozen);
    body.referenceText = "The reference says the required response is READY.";
    body.scenarios[0]!.rubricChecks.push({ id: "S01.r1", kind: "rubric", description: "Reference grounding", rubric: "Assess grounding against the supplied reference.", assessesFactualCorrectness: true, requiresReference: true });
    const frozen = freezeSuite(body), scope = { ...f.scope, suiteDigest: frozen.digest };
    const suite = projectFrozenTextSuite(frozen, scope);
    expect(restoreFrozenTextSuite(suite.suite, suite.retained, scope)).toEqual(frozen);
    f.run.suiteDigest = frozen.digest;
    f.run.executions[0]!.checks.push({ checkId: "S01.r1", kind: "rubric", status: "pass", detail: "Grounded", evidenceQuotes: ["READY"], reason: null });
    for (const status of ["pass", "concern"] as const) {
      f.run.executions[0]!.checks.at(-1)!.status = status;
      const projection = projectTextSuiteRun(f.run, suite, scope);
      expect(projection.result.results[0]!.assessment?.kind).toBe("rubric");
      expect(projection.result.results[0]).not.toHaveProperty("passed");
      expect(projection.result.results[0]!.assessment?.checks.at(-1)!.status).toBe(status);
      expect(restoreTextSuiteRun(projection.result, projection.retained, suite, scope)).toEqual(f.run);
    }
  });
  it("preserves actual infrastructure outcomes without objective booleans", () => {
    const f = fixture(), execution = f.run.executions[0]!;
    execution.outcome = "infrastructure_error";
    execution.target = { ok: false, errorCode: "target_error", latencyMs: 1 };
    execution.responseText = null;
    execution.checks.forEach(c => { c.status = "not_assessed"; c.reason = "target_error"; });
    const projection = projectTextSuiteRun(f.run, f.suite, f.scope);
    expect(projection.result.results[0]!.assessment?.kind).toBe("infrastructure");
    expect(projection.result.results[0]).not.toHaveProperty("passed");
    expect(restoreTextSuiteRun(projection.result, projection.retained, f.suite, f.scope)).toEqual(f.run);
  });
  it("rejects infrastructure inconsistencies and currently known secrets", () => {
    const f = fixture(); f.run.executions[0]!.target.ok = false; expect(() => projectTextSuiteRun(f.run, f.suite, f.scope)).toThrow("mismatch");
    const next = fixture(); expect(() => projectFrozenTextSuite(next.frozen, next.scope, ["Follow the explicit user constraints."])).toThrow();
    expect(() => projectTextSuiteRun(next.run, next.suite, next.scope, ["READY"])).toThrow();
  });
});
