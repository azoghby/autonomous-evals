// Regression coverage for imported provenance and literal citation fidelity.
import { describe, expect, it } from 'vitest';
import { fromContractFinding, toContractFinding } from '../evals/service-adapter';
import { normalizeTrace } from '../evals/trace/normalize';
import type { Finding } from '../evals/types';
import { artifacts, ctx, job, runner, services } from './support';

describe('Regression: provenance across composed report boundaries', () => {
  it('P1: legacy text rendering invents a run ID from the entire location and erases excerpt metadata', async () => {
    const finding: Finding = { id: 'text:S01:S01.o1', source: 'text_eval', category: 'explicit_constraint', title: 'Marker absent', label: 'confirmed', severity: 'medium', basis: 'objective', summary: 'Required marker absent.',
      evidence: [{ kind: 'scenario_response', scenarioId: 'S01', runId: 'baseline-1', quote: 'PARTIAL RESPONSE', truncated: true }], investigatorNote: null, reproduction: { attempted: true, reproduced: true, runId: 'reproduction-1' } };
    const contract = toContractFinding(finding);
    const restored = fromContractFinding(contract);
    expect(restored.evidence[0]).toMatchObject({ scenarioId: 'S01', runId: 'baseline-1', truncated: true });
    expect(restored.reproduction).toEqual({ attempted: true, reproduced: null, runId: null });
    const svc = services(runner(() => { throw new Error('operator disabled'); }));
    const intake = { package: 'trace_audit' as const, trace: 'fixture', authorizedToTest: true as const };
    const rich = await svc.renderReport(ctx, { intake, findings: [], richFindings: [finding] });
    const legacy = await svc.renderReport(ctx, { intake, findings: [contract] });
    expect(rich.html).toContain('scenario S01, run baseline-1 (excerpt)');
    expect(legacy.html).toContain('scenario S01, run baseline-1 (excerpt)');
    expect(legacy.html).toContain('(excerpt)');
    expect(legacy.markdown).toContain('(excerpt)');
    expect(legacy.findings).toEqual([contract]); // contract preserved; presentation still corrupts provenance
    const json = artifacts([restored]).json;
    expect(json.findings[0].evidence[0]).toMatchObject({runId: 'baseline-1'});
    const opaque = fromContractFinding({ ...contract, evidence: [{ kind: 'response', excerpt: 'partial', location: 'arbitrary human location' }] });
    expect(opaque.evidence[0]).toEqual({ kind: 'legacy_excerpt', location: 'arbitrary human location', quote: 'partial', truncated: true });
    expect(artifacts([opaque]).html).toContain('Legacy location: arbitrary human location');
    expect(job.isFixture).toBe(true);
  });
  it('P2: whitespace-normalized trace citation is exported as an exact, untruncated quote never present in the event', async () => {
    const original = 'alpha\r\n\t beta';
    const quote = 'alpha beta';
    const raw = JSON.stringify([{ role: 'assistant', content: original }]);
    expect(normalizeTrace(raw).events[0]!.text).not.toContain(quote);
    const svc = services(runner(() => ({ verdicts: [], additional_findings: [{ category: 'instruction_violation', title: 'Concern', rationale: 'Normalized citation.', severity: 'low', evidence: [{ event_id: 'e1', quote }] }] })));
    const audit = await svc.auditTraceDetailed(ctx, raw, 'Be polite.');
    expect(audit.rejectedAgentFindings).toBe(1);
    expect(audit.findings).toHaveLength(0);
  });
});
