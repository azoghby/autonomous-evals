// Strict mode asserts desired fail-closed behavior. Characterization mode records current unsafe behavior.
import { expect, it, vi } from 'vitest';
import { createDurableProgressProjection } from '../src/reporting/chat/projection';
import { renderReport } from '../src/reporting/render';
import { createTrackBServices } from '../src/evals/service-adapter';
import { compareRichChecks, richChecks } from '../src/monitoring/composition';
import { artifact, ctx, frozen, intake, packIds, progressFixture, reportInput, time } from './fixtures';
const strict = process.env.PACKS_STRICT === '1';
const label = strict ? 'RELEASE BLOCKER' : 'Characterization only';

it(`${label} PACK-REPORT: missing appended evidence must not produce a clean generic report`, () => {
  const out = renderReport(reportInput());
  if (strict) expect(out.summary).not.toContain('No problems were found');
  else {
    expect(out.summary).toContain('No problems were found');
    expect(out.json.details.authorizedScenarioIds).toHaveLength(20);
    expect(out.json.details.executedScenarioIds).toHaveLength(12);
    expect(out.json.evaluationStatus).toBeNull();
  }
});
it(`${label} PACK-SERVICE-REPORT: contract report accepts no execution inventory`, async () => {
  const runner = { run: vi.fn(async () => { throw Error('No agent dispatch permitted'); }) };
  const service = createTrackBServices({ runner, operatorSummary: false, clock: { now: () => new Date(time) },
    resolveJob: async () => ({ customerId: 'local', package: 'text_eval', isFixture: true, linkedRetestOf: null, quoteVersion: null }) });
  const task = service.renderReport(ctx, { intake, findings: [], limitations: ['Appended pack evidence unavailable.'] });
  if (strict) await expect(task).rejects.toMatchObject({ code: 'rejected_input' });
  else {
    const out = await task; expect(out.summary).toContain('No problems were found'); expect(out.findings).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
  }
});
it(`${label} PACK-PROGRESS: resolver omitting appended cases can project delivered`, async () => {
  const f = progressFixture();
  const task = createDurableProgressProjection(f.ports).project(f.scope);
  if (strict) await expect(task).rejects.toMatchObject({ code: 'invalid_snapshot' });
  else {
    const out = await task; expect(out.snapshot.status).toBe('delivered'); expect(out.snapshot.blockers).toEqual([]);
    expect(out.phases[0].outcomes).toHaveLength(12); expect(out.phases[0].outcomes.every(o => o === 'passed')).toBe(true);
    expect(f.plan.checkpoints[0].scenarioIds?.some(id => packIds.includes(id))).toBe(false);
  }
});
it(`${label} PACK-COMPARISON: base-only evidence cannot prove complete application coverage`, () => {
  // The low-level comparator has no application inventory input. The caller must fence this path.
  const checks = richChecks(artifact());
  const out = compareRichChecks(checks, checks);
  if (strict) expect(() => compareRichChecks(checks, checks)).toThrow();
  else {
    expect(out.totalChecks).toBe(frozen.scenarios.length); expect(out.pairedAssessed).toBe(12);
    expect(out.currentCounts.passed).toBe(12); expect(out.unresolved).toEqual([]); expect(out.passRateDelta).toBe(0);
  }
});
