/** Strict execution coverage for the existing conformance harness; not provider or Phase 0 attestation. */
import type { ConformanceCheck } from '../packages/core/src/contracts/conformance';
import type { EvalServices, RunResult } from '../packages/core/src/contracts/services';
import type { Finding, Suite } from '../packages/core/src/contracts';
import { BLOCKED_TARGET_URLS } from '../packages/core/src/contracts/fixtures';

export interface StrictConformanceEvidence {
  calls: Partial<Record<keyof EvalServices, number>>;
  succeeded: Partial<Record<keyof EvalServices, number>>;
  suitePipeline: { designed: number; run: number; investigated: number; rerun: number };
}
const identity = (group: string, name: string) => `${group}: ${name}`;
const expectedChecks = [
  ['qualify', 'output parses (trace_audit)'], ['qualify', 'output parses (text_eval)'],
  ['qualify', 'never returns a price'],
  ['auditTrace', 'unsupported-claim trace yields >=1 confirmed/rubric finding with evidence'],
  ['auditTrace', 'clean trace yields zero confirmed findings'],
  ...BLOCKED_TARGET_URLS.map(url => ['checkTarget', `rejects ${url} without network`]),
  ['renderReport', 'non-empty markdown + html, no <script>, schema-valid'],
  ['proposeAndVerifyFix', 'returns schema-valid Remediation for the finding'],
  ['designSuite', 'returns schema-valid Suite for ctx.jobId'],
  ['runSuite', 'results reference suite scenarios'], ['investigate', 'findings valid with evidence'],
  ['rerunFinding', 'returns schema-valid Finding with same id'],
  ['budget', 'ctx with budgetMicroUsd=0 throws a typed budget error or makes no paid calls'],
  ['branching', 'create -> connection -> delete'],
].map(([group, name]) => identity(group, name));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function requireEvidence(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Strict conformance: ${message}`);
}

export function createStrictConformanceServices(underlying: EvalServices): {
  services: EvalServices;
  evidence: () => StrictConformanceEvidence;
  validate: (checks: ConformanceCheck[]) => ConformanceCheck[];
} {
  const observed: StrictConformanceEvidence = {
    calls: {}, succeeded: {}, suitePipeline: { designed: 0, run: 0, investigated: 0, rerun: 0 },
  };
  let retained: { jobId: string; suite: Suite; run?: RunResult; findings?: Finding[] } | undefined;
  // Explicit forwarding also supports implementations whose methods live on the prototype.
  const services: EvalServices = {
    qualify: (...args) => underlying.qualify(...args),
    auditTrace: (...args) => underlying.auditTrace(...args),
    checkTarget: (...args) => underlying.checkTarget(...args),
    renderReport: (...args) => underlying.renderReport(...args),
    proposeAndVerifyFix: (...args) => underlying.proposeAndVerifyFix(...args),
    createJobBranch: (...args) => underlying.createJobBranch(...args),
    deleteJobBranch: (...args) => underlying.deleteJobBranch(...args),
    ...(underlying.getJobBranchConnection ? { getJobBranchConnection: (id: string) => underlying.getJobBranchConnection!(id) } : {}),
    async designSuite(ctx, intake) {
      retained = undefined;
      const suite = await underlying.designSuite(ctx, intake);
      requireEvidence(suite.jobId === ctx.jobId, 'designed suite job differs from context');
      requireEvidence(suite.scenarios.length > 0 && new Set(suite.scenarios.map(s => s.id)).size === suite.scenarios.length, 'suite scenarios must be nonempty and unique');
      retained = { jobId: ctx.jobId, suite: structuredClone(suite) };
      observed.suitePipeline.designed++;
      return suite;
    },
    async runSuite(ctx, suite, target, branch) {
      requireEvidence(retained && retained.jobId === ctx.jobId && suite.jobId === ctx.jobId && same(suite, retained.suite), 'run must use the retained suite and shared suite job');
      const run = await underlying.runSuite(ctx, suite, target, branch);
      requireEvidence(run.versionLabel === retained.suite.versionLabel, 'run version differs from suite');
      const expected = new Set(retained.suite.scenarios.map(s => s.id));
      const ids = run.results.map(r => r.scenarioId);
      requireEvidence(ids.length > 0 && ids.length === expected.size && new Set(ids).size === ids.length && ids.every(id => expected.has(id)), 'run must cover every scenario exactly once');
      requireEvidence(typeof run.runId === 'string' && run.runId.trim().length > 0, 'run identity missing');
      retained.run = structuredClone(run);
      retained.findings = undefined;
      observed.suitePipeline.run++;
      return run;
    },
    async investigate(ctx, suite, runs) {
      requireEvidence(retained?.run && retained.jobId === ctx.jobId && same(suite, retained.suite) && same(runs, [retained.run]), 'investigation requires the actual retained run and shared suite job');
      const findings = await underlying.investigate(ctx, suite, runs);
      const ids = new Set(retained.suite.scenarios.map(s => s.id));
      requireEvidence(findings.every(f => typeof f.scenarioId === 'string' && ids.has(f.scenarioId)), 'investigation finding scenario binding invalid');
      retained.findings = structuredClone(findings);
      observed.suitePipeline.investigated++;
      return findings;
    },
    async rerunFinding(ctx, finding, scenario) {
      requireEvidence(retained?.findings && retained.jobId === ctx.jobId && retained.findings.some(f => same(f, finding)), 'rerun requires an actual retained investigation finding');
      const expected = retained.suite.scenarios.find(s => s.id === finding.scenarioId);
      requireEvidence(expected && same(expected, scenario), 'rerun scenario differs from retained finding scenario');
      const binding = { id: finding.id, scenarioId: finding.scenarioId };
      const result = await underlying.rerunFinding(ctx, finding, scenario);
      requireEvidence(result.id === binding.id && result.scenarioId === binding.scenarioId, 'rerun changed finding identity or scenario binding');
      observed.suitePipeline.rerun++;
      return result;
    },
  };
  for (const key of Object.keys(services) as Array<keyof EvalServices>) {
    const fn = services[key] as (...args: unknown[]) => Promise<unknown>;
    Object.assign(services, { [key]: async (...args: unknown[]) => {
      observed.calls[key] = (observed.calls[key] ?? 0) + 1;
      const result = await fn(...args);
      observed.succeeded[key] = (observed.succeeded[key] ?? 0) + 1;
      return result;
    } });
  }
  return {
    services,
    evidence: () => structuredClone(observed),
    validate(checks) {
      const out = checks.map(check => ({ ...check }));
      const fail = (name: string, message: string) => out.push({ group: 'strict coverage', name, status: 'fail', message });
      const identities = checks.map(check => identity(check.group, check.name));
      if (identities.some(id => !expectedChecks.includes(id))) fail('unexpected checks', 'Unknown check identities cannot establish coverage');
      if (checks.some(check => !['pass', 'fail', 'skip'].includes(check.status))) fail('unknown status', 'Unknown check status');
      for (const expected of expectedChecks) {
        const matches = checks.filter(check => identity(check.group, check.name) === expected);
        if (matches.length !== 1 || matches[0].status !== 'pass') fail(expected, 'Exactly one passing required check is required');
      }
      if (new Set(identities).size !== identities.length) fail('duplicate checks', 'Repeated check identities cannot establish coverage');
      if (checks.some(check => check.status === 'skip')) fail('skipped checks', 'Strict conformance requires full execution');
      for (const key of Object.keys(services) as Array<keyof EvalServices>) {
        // Safe-target rejection may legitimately throw; the harness checks no network escaped.
        const count = key === 'checkTarget' ? observed.calls[key] : observed.succeeded[key];
        if (!count) fail(`method ${key}`, 'Required method was not exercised as required');
      }
      if (!underlying.getJobBranchConnection) fail('method getJobBranchConnection', 'Branch connection method missing');
      for (const [stage, count] of Object.entries(observed.suitePipeline)) {
        if (!count) fail(`suite ${stage}`, 'Required retained suite pipeline stage was not exercised');
      }
      return out;
    },
  };
}
