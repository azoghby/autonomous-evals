// FIXTURE tests: Track A contract adapter (requires packages/core/src/contracts from Track A).
import { describe, expect, it, vi } from "vitest";
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
    budgetMicroUsd: 999_000_000, // positive context budget is not an atomic reservation
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
  it.each(['qualify', 'auditTrace', 'auditTraceDetailed', 'renderReport'] as const)('refuses zero context budget before %s can call the runner or reserve', async method => {
    const h = harness(confirmAll);
    const run = vi.spyOn(h.service, 'run');
    const reserve = vi.spyOn(h.ledger, 'reserve');
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const { c, costs, progress } = ctx();
    c.budgetMicroUsd = 0;
    const intake = { package: 'trace_audit' as const, trace: FALSE_SUCCESS, authorizedToTest: true as const };
    const operation = method === 'qualify' ? svc.qualify(c, intake, [])
      : method === 'renderReport' ? svc.renderReport(c, { intake, findings: [] })
      : svc[method](c, FALSE_SUCCESS);
    const error = await operation.catch(e => e);
    expect(error).toBeInstanceOf(TrackBBlockedError);
    expect(error).toMatchObject({ code: 'paused_budget', message: 'No evaluation budget remains', retryable: false, sessionIds: [] });
    expect(run).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(h.naive.createCalls).toHaveLength(0);
    expect(h.naive.getCalls).toBe(0);
    expect(costs).toEqual([]);
    expect(progress).toEqual([]);
  });

  it('explicitly enabled operator summary also refuses zero budget before reservation', async () => {
    const h = harness(confirmAll);
    const run = vi.spyOn(h.service, 'run');
    const reserve = vi.spyOn(h.ledger, 'reserve');
    const svc = createTrackBServices({ runner: h.service, resolveJob, operatorSummary: true });
    const { c } = ctx(); c.budgetMicroUsd = 0;
    await expect(svc.renderReport(c, { intake: { package: 'trace_audit', trace: FALSE_SUCCESS, authorizedToTest: true }, findings: [] })).rejects.toMatchObject({ code: 'paused_budget' });
    expect(run).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('allows deterministic report rendering at zero budget when operator summary is disabled', async () => {
    const h = harness(confirmAll);
    const run = vi.spyOn(h.service, 'run');
    const reserve = vi.spyOn(h.ledger, 'reserve');
    const svc = createTrackBServices({ runner: h.service, resolveJob, operatorSummary: false });
    const { c, costs } = ctx(); c.budgetMicroUsd = 0;
    const report = await svc.renderReport(c, { intake: { package: 'trace_audit', trace: FALSE_SUCCESS, authorizedToTest: true }, findings: [] });
    Report.parse(report);
    expect(report.markdown).not.toContain('Summary written by our operator agent');
    expect(run).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(h.naive.createCalls).toHaveLength(0);
    expect(costs).toEqual([]);
  });

  it('resolves current secrets only after authorization and removes JSON-escaped values from audit evidence', async () => {
    const secret = 'opaque-"value\\with-escapes';
    const order: string[] = [];
    const h = harness(confirmAll);
    const svc = createTrackBServices({ runner: h.service,
      resolveJob: async () => { order.push('authorize'); return resolveJob(); },
      resolveKnownSecrets: async () => { order.push('secrets'); return [secret]; },
    });
    // Build proper nested JSON: the provider must never see either representation.
    const events = JSON.parse(FALSE_SUCCESS);
    events[1].content = JSON.stringify({ ok: false, error: secret });
    const result = await svc.auditTraceDetailed(ctx().c, JSON.stringify(events));
    expect(order).toEqual(['authorize', 'secrets']);
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(h.naive.createCalls[0]!.body.message).toContain('[REDACTED]');
    expect(h.naive.createCalls[0]!.body.message).not.toContain('with-escapes');
  });

  it('redacts a known secret spanning the qualification preview/notes clipping boundary', async () => {
    const secret = 'opaque-value-with-no-keyword';
    const h = harness(() => ({ structuredOutput: { decision: 'clarify', recommended_package: 'trace_audit', questions: ['What should be checked?'], scope_summary: 'Trace review.', decline_reason: null } }));
    const svc = createTrackBServices({ runner: h.service, resolveJob, resolveKnownSecrets: async () => [secret] });
    await svc.qualify(ctx().c, { package: 'trace_audit', trace: 'x'.repeat(1490) + secret, notes: 'y'.repeat(2990) + secret, authorizedToTest: true }, []);
    expect(h.naive.createCalls[0]!.body.message).not.toContain('opaque-val');
  });

  it.each([true, false])('rechecks rotated report secrets before dispatch with operator enabled=%s', async operatorSummary => {
    const secret = 'unlabeled-credential-xyz';
    let current: string[] = [];
    const h = harness(confirmAll);
    const svc = createTrackBServices({ runner: h.service, resolveJob, operatorSummary, resolveKnownSecrets: async () => current });
    const result = await svc.auditTraceDetailed(ctx().c, FALSE_SUCCESS);
    const calls = h.naive.createCalls.length;
    current = [secret];
    await expect(svc.renderReport(ctx().c, { intake: { package: 'trace_audit', trace: FALSE_SUCCESS, authorizedToTest: true }, findings: [], richFindings: result.findings, limitations: [secret] })).rejects.toMatchObject({ code: 'rejected_input', message: 'Credential content refused' });
    expect(h.naive.createCalls).toHaveLength(calls);
  });

  it('refuses leaked operator output after recording its measured cost', async () => {
    const secret = 'unlabeled-credential-xyz';
    const h = harness(() => ({ structuredOutput: { executive_summary: secret, finding_notes: [], recommended_next_steps: [], retest_recommended: false } }));
    const svc = createTrackBServices({ runner: h.service, resolveJob, resolveKnownSecrets: async () => [secret] });
    const { c, costs } = ctx();
    await expect(svc.renderReport(c, { intake: { package: 'trace_audit', trace: FALSE_SUCCESS, authorizedToTest: true }, findings: [] })).rejects.toMatchObject({ code: 'rejected_input' });
    expect(costs).toHaveLength(1);
  });

  it('fails closed on unavailable secret policy without exposing its error or dispatching', async () => {
    const h = harness(confirmAll);
    const svc = createTrackBServices({ runner: h.service, resolveJob, resolveKnownSecrets: async () => { throw new Error('private resolver credential'); } });
    await expect(svc.auditTrace(ctx().c, FALSE_SUCCESS)).rejects.toMatchObject({ code: 'needs_operator', message: 'Secret policy unavailable' });
    expect(h.naive.createCalls).toHaveLength(0);
  });

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

  it('preserves measured-cost redelivery on a positive-budget completed replay', async () => {
    const h = harness(confirmAll);
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const { c, costs } = ctx();
    const first = await svc.auditTrace(c, FALSE_SUCCESS);
    const creates = h.naive.createCalls.length;
    const replay = await svc.auditTrace(c, FALSE_SUCCESS);
    expect(replay).toEqual(first);
    expect(h.naive.createCalls).toHaveLength(creates);
    expect(costs).toHaveLength(2);
    expect(costs[1]).toEqual(costs[0]); // The application's keyed cost sink deduplicates these deliveries.
  });

  it("maps ledger budget exhaustion to paused_budget despite a positive context budget", async () => {
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
