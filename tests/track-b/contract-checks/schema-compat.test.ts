/**
 * Track A shared-contract checks. Staged by tests/track-b/run-checks.mjs as src/contract-checks/;
 * the relative imports resolve only there, against contracts read from the selected Track A revision.
 *
 * Tests titled "KNOWN GAP" pin documented contract limitations (docs/track-b-contract-compatibility.md).
 * They assert the gap is still open. If Track A fixes one, the test fails on purpose: update this check
 * and the document together. Nothing here changes a Track A contract.
 */
import { describe, expect, it } from 'vitest';
import {
  CostEntry, Finding, IntakeInput, JOB_BUDGET_MICRO_USD, MAX_TRACE_BYTES, PRICE_CENTS, Quote, Scenario, Suite,
  type Finding as FindingType, type Scenario as ScenarioType,
} from '../contracts/index';
import type { EvalServices, RunResult, ServiceContext } from '../contracts/services';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

// Compile-time pins (tsc fails the run when Track A changes any of these shapes). Each mirrors a documented gap.
export type ContractShapePins = [
  /** rerunFinding has no target credentials or frozen state input. */
  Assert<Equal<Parameters<EvalServices['rerunFinding']>, [ServiceContext, FindingType, ScenarioType | undefined]>>,
  /** deleteJobBranch accepts only a bare branch ID, not job authority. */
  Assert<Equal<Parameters<EvalServices['deleteJobBranch']>, [string]>>,
  /** RunResult has a boolean outcome only. */
  Assert<Equal<RunResult['results'][number], { scenarioId: string; passed: boolean; detail: string }>>,
  /** Budget is a plain number, not a reservation handle. */
  Assert<Equal<ServiceContext['budgetMicroUsd'], number>>,
  /** Findings carry no typed run/branch association. */
  Assert<Equal<Extract<keyof FindingType, 'runId' | 'branchId' | 'versionLabel'>, never>>,
  /** Current service surface, including remediation and optional private branch resolution. */
  Assert<Equal<keyof EvalServices, 'qualify' | 'auditTrace' | 'checkTarget' | 'designSuite' | 'runSuite' | 'investigate' | 'renderReport' | 'createJobBranch' | 'deleteJobBranch' | 'rerunFinding' | 'getJobBranchConnection' | 'proposeAndVerifyFix'>>,
];

const jobId = '11111111-1111-4111-8111-111111111111';
const evidence = [{ kind: 'trace_excerpt' as const, excerpt: 'tool returned 500', location: 'msg 3' }];
const finding = { id: 'f1', title: 'False success', status: 'confirmed' as const, severity: 'high' as const, category: 'false_success' as const, description: 'd', evidence };

describe('baseline shared-contract compatibility', () => {
  it('uses the planned pilot prices and aggregate job caps', () => {
    expect(PRICE_CENTS).toEqual({ trace_audit: 500, text_eval: 500, workflow_eval: 500, version_comparison: 1000 });
    expect(JOB_BUDGET_MICRO_USD).toEqual({ trace_audit: 3_000_000, text_eval: 3_000_000, workflow_eval: 3_000_000, version_comparison: 5_000_000 });
  });

  it('parses a quote, finding, and calendar scenario with a state check', () => {
    expect(Quote.safeParse({ jobId, version: 1, package: 'trace_audit', priceCents: 500, scopeSummary: 's', deliverables: ['report'], environment: 'test' }).success).toBe(true);
    for (const status of ['confirmed', 'rubric_concern', 'inconclusive'] as const) expect(Finding.safeParse({ ...finding, status }).success).toBe(true);
    expect(Finding.safeParse({ ...finding, evidence: [] }).success).toBe(false);
    const scenario = Scenario.parse({ id: 's1', title: 't', category: 'conflict', input: 'book', checks: [{ kind: 'state', description: 'no overlap', spec: { kind: 'no_overlap', calendarId: 'personal' } }] });
    expect(scenario.checks[0]!.spec).toEqual({ kind: 'no_overlap', calendarId: 'personal' });
    expect(Scenario.safeParse({ ...scenario, checks: [] }).success).toBe(false);
  });

  it('accepts a trace audit intake and rejects an ASCII trace one byte over the cap', () => {
    const intake = { package: 'trace_audit' as const, authorizedToTest: true as const };
    expect(IntakeInput.safeParse({ ...intake, trace: 'a'.repeat(MAX_TRACE_BYTES) }).success).toBe(true);
    expect(IntakeInput.safeParse({ ...intake, trace: 'a'.repeat(MAX_TRACE_BYTES + 1) }).success).toBe(false);
    expect(IntakeInput.safeParse({ ...intake, trace: 'a', authorizedToTest: false }).success).toBe(false);
  });

  it('bounds suites to at most twelve scenarios', () => {
    const scenario = { id: 's', title: 't', category: 'c', input: 'i', checks: [{ kind: 'objective' as const, description: 'd' }] };
    const suite = (count: number) => ({ jobId, frozenAt: '2026-11-07T00:00:00.000Z', scenarios: Array.from({ length: count }, (_, i) => ({ ...scenario, id: `s${i}` })) });
    expect(Suite.safeParse(suite(12)).success).toBe(true);
    expect(Suite.safeParse(suite(13)).success).toBe(false);
  });
});

describe('documented contract gaps (Track B engine must compensate)', () => {
  it('KNOWN GAP: trace cap counts UTF-16 code units, so multibyte input exceeds 200 KB', () => {
    const trace = '€'.repeat(MAX_TRACE_BYTES - 1); // 1 code unit each, 3 UTF-8 bytes each
    expect(trace.length).toBeLessThan(MAX_TRACE_BYTES);
    expect(Buffer.byteLength(trace, 'utf8')).toBeGreaterThan(MAX_TRACE_BYTES);
    expect(IntakeInput.safeParse({ package: 'trace_audit', trace, authorizedToTest: true }).success).toBe(true);
    // The engine's independent guard must reject this input.
    expect(Buffer.byteLength(trace, 'utf8') > MAX_TRACE_BYTES).toBe(true);
  });

  it('KNOWN GAP: the suite schema accepts empty or short suites although ordinary jobs need twelve', () => {
    const base = { jobId, frozenAt: '2026-11-07T00:00:00.000Z' };
    expect(Suite.safeParse({ ...base, scenarios: [] }).success).toBe(true);
    const one = { id: 's', title: 't', category: 'c', input: 'i', checks: [{ kind: 'objective', description: 'd' }] };
    expect(Suite.safeParse({ ...base, scenarios: [one] }).success).toBe(true);
  });

  it('KNOWN GAP: finding parsing silently strips run, branch, and version association', () => {
    const parsed = Finding.parse({ ...finding, runId: 'run-1', branchId: 'br-1', versionLabel: 'B' }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('runId');
    expect(parsed).not.toHaveProperty('branchId');
    expect(parsed).not.toHaveProperty('versionLabel');
    expect(Object.keys(parsed).sort()).toEqual(['category', 'description', 'evidence', 'id', 'reproductions', 'severity', 'status', 'title']);
  });

  it('KNOWN GAP: a cost entry cannot represent unknown cost except as zero plus metadata', () => {
    const entry = { jobId, source: 'ai_gateway' as const, agent: 'judge' as const };
    expect(CostEntry.safeParse({ ...entry, microUsd: null }).success).toBe(false);
    expect(CostEntry.safeParse({ ...entry, microUsd: -1 }).success).toBe(false);
    expect(CostEntry.safeParse({ ...entry, microUsd: 0, meta: { costKnown: false } }).success).toBe(true);
    // Callers must treat meta.costKnown === false as unknown, never as free; the schema does not enforce it.
    expect(CostEntry.parse({ ...entry, microUsd: 0, meta: { costKnown: false } }).microUsd).toBe(0);
  });

  it('KNOWN GAP: run results expose pass/fail only, so errors and inconclusive checks cannot be distinguished', () => {
    const sample: RunResult = { runId: 'r', versionLabel: 'A', results: [{ scenarioId: 's', passed: false, detail: 'infrastructure error or behavioral failure?' }] };
    expect(Object.keys(sample.results[0]!).sort()).toEqual(['detail', 'passed', 'scenarioId']);
  });
});
