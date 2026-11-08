import { describe, expect, it } from 'vitest';
import { toContractFinding } from '../evals/service-adapter';
import { investigateTextRun } from '../evals/text/investigate';
import { executeSuite } from '../evals/text/execute';
import { evaluateObjectiveCheck } from '../evals/text/objective';
import { makeScenarios, makeSuite } from '../evals/text/__tests__/fixtures';
import { escapeHtml, mdFence } from '../reporting/render';
import { artifacts, ctx, envelope, job, runner, services, trace, verdicts } from './support';

const intake = { package: 'trace_audit' as const, trace, authorizedToTest: true as const };
describe('ACCEPTANCE: composed trace -> rich/legacy -> report boundaries', () => {
  it.each([
    [{ event_id: 'e2', quote: 'Your review is booked.' }], // exists, but in another event
    [{ event_id: 'e2', quote: 'FABRICATED_PROVENANCE' }],
    [{ event_id: 'e2', quote: 'dependency unavailable' }, { event_id: 'e404', quote: 'FABRICATED_PROVENANCE' }],
  ].map(evidence => ({ evidence })))('rejects the entire verdict with invalid event-bound evidence %j', async ({ evidence }) => {
    const svc = services(runner(s => verdicts(s.message, evidence)));
    const audit = await svc.auditTraceDetailed(ctx, trace);
    expect(audit.findings.length).toBeGreaterThan(0);
    expect(audit.findings.every(f => f.label === 'inconclusive')).toBe(true);
    const rendered = artifacts(audit.findings, audit.limitations);
    const legacy = audit.findings.map(toContractFinding);
    const report = await svc.renderReport(ctx, { intake, findings: legacy });
    expect(report.findings).toEqual(legacy);
    for (const text of [JSON.stringify(rendered.json), rendered.markdown, rendered.html!, report.markdown, report.html]) {
      expect(text).not.toContain('FABRICATED_PROVENANCE');
      expect(text).toContain('dependency unavailable');
    }
    expect(rendered.json.findings[0].evidence).toEqual(audit.findings[0]!.evidence);
    expect(report.html).not.toContain('<script>bad()');
  });
  it('retains original evidence and inconclusive status after malformed structured investigator output', async () => {
    const svc = services(runner(s => ({ ...verdicts(s.message, []), verdicts: [{ candidate_id: 'C1', evidence: [{ event_id: null, quote: 7 }] }] })));
    const audit = await svc.auditTraceDetailed(ctx, trace);
    expect(audit.investigator.status).toBe('unavailable');
    expect(audit.findings.every(f => f.label === 'inconclusive')).toBe(true);
    const r = artifacts(audit.findings, audit.limitations);
    expect(r.json.findings[0].evidence.length).toBeGreaterThan(0);
    expect(r.markdown).toContain('failed schema validation');
    expect(r.html).toContain('failed schema validation');
  });
  it('preserves exact hostile Unicode/CRLF quote through extra finding, JSON, fences and HTML escaping', async () => {
    const quote = 'İSTANBUL\r\n```\n</code><script>x()</script>';
    const svc = services(runner(() => ({ verdicts: [], additional_findings: [{ category: 'instruction_violation', title: 'Local concern', rationale: 'Evidence only.', severity: 'low', evidence: [{ event_id: 'e1', quote }] }] })));
    const audit = await svc.auditTraceDetailed(ctx, JSON.stringify([{ role: 'assistant', content: quote }]), 'Be polite.');
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]!.label).toBe('rubric_concern');
    const r = artifacts(audit.findings);
    expect(r.json.findings[0].evidence[0].quote).toBe(quote);
    expect(r.markdown).toContain(mdFence(quote));
    expect(r.html).toContain(escapeHtml(quote));
    expect(r.html).not.toContain('<script>');
    const report = await svc.renderReport(ctx, { intake, findings: [], richFindings: audit.findings });
    expect(report.html).toContain(escapeHtml(quote));
    expect(report.findings[0]!.evidence[0]!.excerpt).toBe(quote);
  });
  it('checks investigator quotes against normalized source rather than the 1500-character prompt excerpt', async () => {
    const tail = 'RETAINED_SOURCE_SUFFIX';
    const raw = JSON.stringify([{ role: 'assistant', content: 'x'.repeat(2000) + tail }]);
    let prompt = '';
    const svc = services(runner(s => { prompt = s.message; return { verdicts: [], additional_findings: [{ category: 'instruction_violation', title: 'Source-backed concern', rationale: 'Source citation.', severity: 'low', evidence: [{ event_id: 'e1', quote: tail }] }] }; }));
    const audit = await svc.auditTraceDetailed(ctx, raw, 'Be polite.');
    expect(envelope(prompt).events[0].clipped).toBe(true);
    expect(prompt).not.toContain(tail);
    expect(audit.input.warnings).toEqual([]); // prompt clipping is distinct from source clipping
    expect(audit.rejectedAgentFindings).toBe(0);
    const r = artifacts(audit.findings);
    expect(r.json.findings[0].evidence[0]).toMatchObject({ eventId: 'e1', quote: tail });
    expect(r.markdown).toContain(tail);
    expect(r.html).toContain(tail);
  });
  it('rejects a quote clipped out of normalized trace even if present in raw input and propagates clipping limits', async () => {
    const raw = JSON.stringify([{ role: 'assistant', content: 'x'.repeat(21000) + 'TAIL_ONLY_PROVENANCE' }]);
    let prompt = '';
    const svc = services(runner(s => { prompt = s.message; return { verdicts: [], additional_findings: [{ category: 'instruction_violation', title: 'Invented support', rationale: 'Tail claim.', severity: 'low', evidence: [{ event_id: 'e1', quote: 'TAIL_ONLY_PROVENANCE' }] }] }; }));
    const audit = await svc.auditTraceDetailed(ctx, raw, 'Be polite.');
    expect(raw).toContain('TAIL_ONLY_PROVENANCE');
    expect(prompt).not.toContain('TAIL_ONLY_PROVENANCE');
    expect(envelope(prompt).events[0].clipped).toBe(true);
    expect(audit.rejectedAgentFindings).toBe(1);
    expect(audit.findings).toEqual([]);
    const r = artifacts(audit.findings, audit.limitations);
    expect(r.json.limitations.some((s: string) => s.includes('clipped'))).toBe(true);
    expect(r.markdown).toContain('clipped');
    expect(r.html).toContain('clipped');
  });
});

describe('ACCEPTANCE: text full-response evidence -> reproduction -> rich report', () => {
  it.each(['FORBIDDEN_MARKER', 'FABRICATED_PROVENANCE'])('binds trailing evidence and reproduction independently of investigator quote %s', async quote => {
    const scenarios = makeScenarios();
    scenarios[0]!.objectiveChecks[0]!.spec = { type: 'not_contains', value: 'FORBIDDEN_MARKER', case_sensitive: true };
    const suite = makeSuite({ scenarios });
    const response = 'x'.repeat(21000) + ' FORBIDDEN_MARKER';
    const deps = { target: { send: async () => ({ ok: true as const, text: response, latencyMs: 1 }) }, judge: null, evaluateObjective: evaluateObjectiveCheck };
    const run = await executeSuite(suite, 'original-provenance', deps, { scenarioIds: ['S01'] });
    const result = await investigateTextRun({ job: { ...job, package: 'text_eval' }, suite, run }, { ...deps, runner: runner(() => ({ reproduceScenarioIds: ['S01'], verdicts: [{ candidateId: 'text:S01:S01.o1', verdict: 'confirmed', rationale: 'Reproduced.', quote, defectNote: null }] })) });
    expect(run.executions[0]!.responseClipped).toBe(true);
    expect(run.executions[0]!.responseText).not.toContain('FORBIDDEN_MARKER');
    expect(result.findings[0]).toMatchObject({ label: quote === 'FORBIDDEN_MARKER' ? 'confirmed' : 'inconclusive', reproduction: { attempted: true, reproduced: true } });
    const r = artifacts(result.findings, result.limitations);
    const evidence = r.json.findings[0].evidence.filter((e: any) => e.kind === 'scenario_response');
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      expect(response).toContain(e.quote);
      expect(e.runId).toBe(run.runId);
      expect(e.scenarioId).toBe('S01');
    }
    for (const text of [JSON.stringify(r.json), r.markdown, r.html!]) {
      expect(text).not.toContain('FABRICATED_PROVENANCE');
      expect(text).toContain('FORBIDDEN_MARKER');
    }
    const report = await services(runner(() => { throw new Error('operator disabled'); })).renderReport(ctx, { intake, findings: [], richFindings: result.findings });
    expect(report.markdown).toContain('run original\\-provenance');
    expect(report.html).toContain('run original-provenance');
  });
});
