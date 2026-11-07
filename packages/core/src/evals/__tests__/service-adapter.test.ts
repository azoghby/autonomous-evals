// FIXTURE tests: Track A contract adapter (requires packages/core/src/contracts from Track A).
import { describe, expect, it } from "vitest";
import { Finding as ContractFinding, QualifyResult, Report } from "../../contracts/index";
import type { ServiceContext } from "../../contracts/services";
import { harness } from "../../agents/__tests__/fakes";
import { createTrackBServices, TrackBBlockedError, TrackBPendingError } from "../service-adapter";
import { usd } from "../types";

const JOB = "7d3f0c5e-4b1a-4e8e-9d55-0a1b2c3d4e5f";

function ctx() {
  const costs: unknown[] = [];
  const progress: string[] = [];
  const c: ServiceContext = {
    jobId: JOB,
    environment: "test",
    budgetMicroUsd: 999_000_000, // informational only; must not be treated as a reservation
    recordCost: async (e) => void costs.push(e),
    recordProgress: async (m) => void progress.push(m),
  };
  return { c, costs, progress };
}

const resolveJob = async () => ({ customerId: "cust", package: "trace_audit" as const, isFixture: true, linkedRetestOf: null, quoteVersion: 1 });

const FALSE_SUCCESS = JSON.stringify([
  { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "send_email", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: '{"ok":false,"error":"smtp down"}' },
  { role: "assistant", content: "The email was sent." },
]);

const confirmAll = (body: { message: string }) => {
  const m = body.message;
  if (!m.includes("Trace Audit candidates")) {
    return { structuredOutput: { executive_summary: "One confirmed issue.", finding_notes: [], recommended_next_steps: [], retest_recommended: false } };
  }
  const data = JSON.parse(m.slice(m.indexOf("<untrusted_data>") + 16, m.indexOf("</untrusted_data>")));
  return { structuredOutput: { verdicts: data.candidates.map((c: { candidate_id: string }) => ({ candidate_id: c.candidate_id, verdict: "confirmed", rationale: "ok", evidence: [], defect_note: null })), additional_findings: [] } };
};

describe("Track B services over the Track A contract", () => {
  it.each(['budget_paused', 'awaiting_user'])("records measured %s investigator spend before raising the blocked state", async stopReason => {
    const h = harness(() => ({ status: 'idle', stopReason, structuredOutput: null }));
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const { c, costs } = ctx();
    await expect(svc.auditTrace(c, FALSE_SUCCESS)).rejects.toBeInstanceOf(TrackBBlockedError);
    expect(costs).toEqual([expect.objectContaining({ microUsd: 12_345, meta: expect.objectContaining({ measured: true }) })]);
  });

  it('records qualification schema-failure cost and preserves validation details', async () => {
    const h = harness(() => ({ structuredOutput: { malformed: true } }));
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const { c, costs } = ctx();
    const error = await svc.qualify(c, { package: 'trace_audit', trace: FALSE_SUCCESS, authorizedToTest: true }, []).catch(e => e);
    expect(error).toBeInstanceOf(TrackBBlockedError);
    expect(error.message).toMatch(/^schema_failed: .+/);
    expect(costs).toEqual([expect.objectContaining({ microUsd: 12_345 })]);
  });

  it('records operator budget-pause cost before blocking report generation', async () => {
    const h = harness(() => ({ status: 'idle', stopReason: 'budget_paused', structuredOutput: null }));
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const { c, costs } = ctx();
    await expect(svc.renderReport(c, { intake: { package: 'trace_audit', trace: FALSE_SUCCESS, authorizedToTest: true }, findings: [] })).rejects.toBeInstanceOf(TrackBBlockedError);
    expect(costs).toEqual([expect.objectContaining({ microUsd: 12_345 })]);
  });
  it("auditTrace returns contract-valid findings and records each session cost once per call", async () => {
    const h = harness(confirmAll);
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const { c, costs, progress } = ctx();
    const r = await svc.auditTrace(c, FALSE_SUCCESS);
    expect(r.claimsChecked).toBe(1);
    expect(r.findings.map((f) => ContractFinding.parse(f).status)).toEqual(["confirmed"]);
    expect(r.findings[0]!.evidence.map((e) => e.excerpt).join(" ")).toContain("smtp down");
    expect(costs).toEqual([expect.objectContaining({ source: "naive", agent: "investigator", microUsd: 12_345, meta: expect.objectContaining({ idempotencyKey: expect.stringMatching(/^naive:ses_/) }) })]);
    expect(progress).toEqual(["investigating"]);
  });

  it("maps budget exhaustion to a blocked error (job -> paused_budget), ignoring ctx.budgetMicroUsd", async () => {
    const h = harness(confirmAll);
    h.ledger.caps.set(`job:${JOB}`, usd(0.1));
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const e = await svc.auditTrace(ctx().c, FALSE_SUCCESS).catch((x) => x);
    expect(e).toBeInstanceOf(TrackBBlockedError);
    expect(e.code).toBe("paused_budget");
  });

  it("maps a running session to a retryable pending error", async () => {
    const h = harness((b) => ({ ...confirmAll(b), pollsUntilDone: 10 }), { maxWaitMs: 1_000 });
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    expect(await svc.auditTrace(ctx().c, FALSE_SUCCESS).catch((x) => x)).toBeInstanceOf(TrackBPendingError);
  });

  it("qualify strips the endpoint key from the prompt and returns a contract QualifyResult", async () => {
    const h = harness(() => ({ structuredOutput: { decision: "quote", recommended_package: "text_eval", questions: [], scope_summary: "Twelve scenarios.", decline_reason: null } }));
    const svc = createTrackBServices({ runner: h.service, resolveJob: async () => ({ ...(await resolveJob()), package: "text_eval" as const }) });
    const q = await svc.qualify(ctx().c, { package: "text_eval", endpoint: { url: "https://api.customer.example/v1?token=abc", model: "m", apiKey: "cust-secret-key-77", systemPrompt: "Be brief." }, authorizedToTest: true }, []);
    QualifyResult.parse(q);
    const msg = h.naive.createCalls[0]!.body.message;
    expect(msg).not.toContain("cust-secret-key-77");
    expect(msg).not.toContain("token=abc");
    expect(msg).toContain("api.customer.example");
  });

  it("renderReport returns a contract Report with escaped HTML and an agent-written summary", async () => {
    const h = harness(confirmAll);
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const audit = await svc.auditTraceDetailed(ctx().c, FALSE_SUCCESS);
    const rep = await svc.renderReport(ctx().c, { intake: { package: "trace_audit", trace: FALSE_SUCCESS, authorizedToTest: true }, findings: [], richFindings: audit.findings, limitations: audit.limitations });
    Report.parse(rep);
    expect(rep.summary).toBe("One confirmed issue.");
    expect(rep.markdown).toContain("Summary written by our operator agent");
    expect(rep.monitoringPitch).toContain("$49/month");
  });
});
