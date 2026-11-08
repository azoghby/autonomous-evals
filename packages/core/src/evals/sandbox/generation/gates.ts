import { createHash } from 'node:crypto';
import { EnvironmentSpec, SandboxScenario, type SandboxRun } from '../../../sandbox/spec';
import { canonicalJson } from '../../text/freeze';

export function gateDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export type GateRole = 'oracle' | 'do_nothing' | 'empty' | 'dump';
export interface ExecutionOutcome {
  status: 'completed' | 'failed' | 'unknown';
  transcript: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
  /** null means unknown, never zero. Trusted executor supplies measured settled usage. */
  costMicroUsd: number | null;
  evidenceRef: string;
}
export interface GateCheck { id: string; passed: boolean; rewardBearing: boolean }
export interface GateGrade { complete: boolean; checks: GateCheck[] }
export interface MutationPlan { id: string; targetCheckId: string }
export interface GateScope { jobId: string; environmentId: string }
export interface GateVersions { runtime: string; grader: string; oracle: string; controls: string; mutation: string }
/** Implement with durable atomic compare-and-insert and exclusive execution. A crash after a
 * side effect must reconcile that operation by its key, never blindly rerun it. Conflicting
 * digests reject; pending/ambiguous work remains pending. An in-memory map is test-only. */
export interface GateReplayPort {
  once<T>(key: string, inputDigest: string, operation: () => Promise<T>): Promise<T>;
}
export interface GatePorts {
  replay: GateReplayPort;
  /** Fresh isolated world, validated fixtures, SELECT-only grading and resource limits. */
  startRun(input: { environment: EnvironmentSpec; scenario: SandboxScenario; key: string }): Promise<SandboxRun>;
  /** Trusted reference executor and dump-all-state control. Never use model-supplied grades.
   * do_nothing/empty are constructed locally and do not dispatch an agent. */
  execute(input: { role: 'oracle' | 'dump'; run: SandboxRun; environment: EnvironmentSpec; scenario: SandboxScenario; key: string }): Promise<ExecutionOutcome>;
  grade(input: { run: SandboxRun; execution: ExecutionOutcome; scenario: SandboxScenario }): Promise<GateGrade>;
  mutations(input: { scenario: SandboxScenario; oracleGrade: GateGrade }): Promise<MutationPlan[]>;
  /** Fork oracle's post-run world and evidence, then actually perturb the fork. Never change
   * the baseline. Relevant state/trajectory/transcript mutation depends on target grader. */
  mutate(input: { oracleRun: SandboxRun; oracleExecution: ExecutionOutcome; plan: MutationPlan; key: string }): Promise<{ run: SandboxRun; execution: ExecutionOutcome }>;
}
export interface GateQualityCostPolicy {
  version: 'sandbox-quality-cost-policy-v1';
  maxCostMicroUsd: number;
}
export function validGateQualityCostPolicy(policy: GateQualityCostPolicy): boolean {
  return policy?.version === 'sandbox-quality-cost-policy-v1'
    && Number.isSafeInteger(policy.maxCostMicroUsd) && policy.maxCostMicroUsd >= 0;
}
const executionRule = 'sandbox-gate-execution-v2' as const;
export interface GateInput {
  /** Trusted server policy only. Customer target budgets need not constrain oracle costs. */
  qualityCostPolicy?: GateQualityCostPolicy;
  environment: EnvironmentSpec;
  scenario: SandboxScenario;
  scope: GateScope;
  versions: GateVersions;
  replayKey: string;
}
export interface RunGateEvidence { role: GateRole; runId: string; execution: ExecutionOutcome; grade: GateGrade }
export interface MutationEvidence { plan: MutationPlan; runId: string; execution: ExecutionOutcome; grade: GateGrade }
export interface ScenarioGateEvidence {
  schema: 'sandbox-gate-evidence-v1';
  /** Absent on preserved legacy evidence, which requires known cost. */
  executionRule?: typeof executionRule;
  qualityCostPolicy?: GateQualityCostPolicy;
  bindingDigest: string;
  environmentDigest: string;
  scenarioDigest: string;
  scope: GateScope;
  versions: GateVersions;
  status: 'passed' | 'rejected' | 'unresolved';
  reasons: string[];
  runs: RunGateEvidence[];
  mutations: MutationEvidence[];
  digest: string;
}
export function requiredGateCheckIds(s: SandboxScenario): string[] {
  return [
    ...s.stateAssertions.map(a => `state:${a.id}`),
    ...s.expectedChanges.map(a => `expected:${a.id}`),
    ...s.trajectoryAssertions.map(a => `trajectory:${a.id}`),
    ...s.requiredOutputs.map(a => `output:${a.id}`),
    'collateral',
    ...(s.expectRefusal ? ['refusal'] : []),
    ...s.attachments.map(a => `media:${a.id}`),
    ...(s.faults.some(f => f.fault === 'injected_instruction') || s.attachments.some(a => a.injection) ? ['security'] : []),
  ];
}
function validExecution(e: ExecutionOutcome, allowUnknownCost = false, policy?: GateQualityCostPolicy): boolean {
  return e.status === 'completed'
    && ((e.costMicroUsd === null && allowUnknownCost && !policy)
      || (Number.isSafeInteger(e.costMicroUsd) && e.costMicroUsd! >= 0))
    && typeof e.evidenceRef === 'string' && e.evidenceRef.length > 0
    && Array.isArray(e.transcript) && e.transcript.every(t => ['user', 'assistant', 'tool'].includes(t.role) && typeof t.content === 'string');
}
function validGrade(g: GateGrade, required: string[]): boolean {
  return g.complete === true && Array.isArray(g.checks) && g.checks.length > 0
    && new Set(g.checks.map(c => c.id)).size === g.checks.length
    && g.checks.every(c => typeof c.id === 'string' && typeof c.passed === 'boolean' && typeof c.rewardBearing === 'boolean')
    && required.every(id => g.checks.some(c => c.id === id && c.rewardBearing));
}
function passed(g: GateGrade): boolean { return g.checks.filter(c => c.rewardBearing).every(c => c.passed); }
function binding(input: GateInput, rule?: typeof executionRule) {
  const { environment, scenario, scope, versions, qualityCostPolicy } = input;
  return { environment, scenario, scope, versions,
    ...(rule ? { executionRule: rule, ...(qualityCostPolicy ? { qualityCostPolicy } : {}) } : {}) };
}
function withinCostPolicy(e: ExecutionOutcome, policy?: GateQualityCostPolicy): boolean {
  return !policy || (e.costMicroUsd !== null && e.costMicroUsd <= policy.maxCostMicroUsd);
}
function assertInput(input: GateInput): void {
  if (input.qualityCostPolicy !== undefined && !validGateQualityCostPolicy(input.qualityCostPolicy)) throw new Error('Invalid quality cost policy');
  EnvironmentSpec.parse(input.environment);
  SandboxScenario.parse(input.scenario);
  if (!input.environment.workflows.some(w => w.id === input.scenario.workflowId)) throw new Error('Unknown scenario workflow');
  if (![input.scope.jobId, input.scope.environmentId, input.replayKey, input.versions.runtime, input.versions.grader, input.versions.oracle, input.versions.controls, input.versions.mutation].every(v => typeof v === 'string' && v.length > 0)) throw new Error('Missing gate identity');
  if (new Set(requiredGateCheckIds(input.scenario)).size !== requiredGateCheckIds(input.scenario).length) throw new Error('Duplicate assertion identifiers');
  if (input.scenario.expectRefusal && input.scenario.requiredOutputs.length === 0) throw new Error('Refusal requires explicit deterministic output assertions');
}
/** Rechecks durable evidence semantics; hashes provide integrity, not authentication.
 * Production artifact builders must load this evidence from the trusted replay store. */
export function passingGateEvidence(e: ScenarioGateEvidence, scenario: SandboxScenario): boolean {
  if (e.schema !== 'sandbox-gate-evidence-v1' || e.status !== 'passed' || e.reasons.length || e.runs.length !== 4) return false;
  if (e.executionRule !== undefined && e.executionRule !== executionRule) return false;
  if (e.qualityCostPolicy !== undefined && (!e.executionRule || !validGateQualityCostPolicy(e.qualityCostPolicy))) return false;
  const roles: GateRole[] = ['oracle', 'do_nothing', 'empty', 'dump'];
  const required = requiredGateCheckIds(scenario);
  if (roles.some(role => e.runs.filter(r => r.role === role).length !== 1)) return false;
  if (e.runs.some(r => !validExecution(r.execution, e.executionRule === executionRule, e.qualityCostPolicy) || !validGrade(r.grade, required) || (passed(r.grade) && withinCostPolicy(r.execution, e.qualityCostPolicy)) !== (r.role === 'oracle'))) return false;
  const oracle = e.runs.find(r => r.role === 'oracle')!;
  const targets = oracle.grade.checks.filter(c => c.rewardBearing).map(c => c.id);
  if (e.mutations.length > 200 || new Set(e.mutations.map(m => m.plan.id)).size !== e.mutations.length) return false;
  if (targets.some(id => !e.mutations.some(m => m.plan.targetCheckId === id))) return false;
  if (e.mutations.some(m => !m.plan.id || !targets.includes(m.plan.targetCheckId)
    || !validExecution(m.execution, e.executionRule === executionRule, e.qualityCostPolicy) || !validGrade(m.grade, required)
    || !m.grade.checks.some(c => c.id === m.plan.targetCheckId && c.rewardBearing && c.passed === false))) return false;
  const runIds = [...e.runs, ...e.mutations].map(r => r.runId);
  if (runIds.some(id => !id) || new Set(runIds).size !== runIds.length) return false;
  for (const role of ['do_nothing', 'empty'] as const) {
    const control = e.runs.find(r => r.role === role)!.execution;
    const expected = role === 'empty' ? [{ role: 'assistant', content: '' }] : [];
    if (control.costMicroUsd !== 0 || canonicalJson(control.transcript) !== canonicalJson(expected)) return false;
  }
  return true;
}
/** Executes gates, never reads oracleValidated. Supplied ports are trusted infrastructure;
 * this API does not authenticate a runtime or prove that an arbitrary port ran real SQL. */
export async function runScenarioGates(raw: GateInput, ports: GatePorts): Promise<ScenarioGateEvidence> {
  const input = structuredClone(raw);
  assertInput(input);
  const bindingDigest = gateDigest(binding(input, executionRule));
  const result = await ports.replay.once(input.replayKey, bindingDigest, async () => {
    const runs: RunGateEvidence[] = [], mutations: MutationEvidence[] = [], reasons: string[] = [];
    const live = new Set<SandboxRun>(), ids = new Set<string>();
    let unresolved = false;
    const register = (run: SandboxRun) => {
      live.add(run);
      if (!run.runId || ids.has(run.runId)) throw new Error('Run isolation identity reused');
      ids.add(run.runId);
      return run;
    };
    try {
      let oracleRun: SandboxRun | undefined;
      for (const role of ['oracle', 'do_nothing', 'empty', 'dump'] as const) {
        const key = `${input.replayKey}/${role}`;
        const run = register(await ports.startRun({ environment: structuredClone(input.environment), scenario: structuredClone(input.scenario), key }));
        const execution = role === 'do_nothing' || role === 'empty'
          ? { status: 'completed' as const, transcript: role === 'empty' ? [{ role: 'assistant' as const, content: '' }] : [], costMicroUsd: 0, evidenceRef: key }
          : structuredClone(await ports.execute({ role, run, environment: structuredClone(input.environment), scenario: structuredClone(input.scenario), key }));
        const grade = structuredClone(await ports.grade({ run, execution: structuredClone(execution), scenario: structuredClone(input.scenario) }));
        runs.push({ role, runId: run.runId, execution, grade });
        if (!validExecution(execution, true, input.qualityCostPolicy) || !validGrade(grade, requiredGateCheckIds(input.scenario))) { unresolved = true; reasons.push(`${role}:incomplete_execution_or_grade`); }
        else if ((passed(grade) && withinCostPolicy(execution, input.qualityCostPolicy)) !== (role === 'oracle')) reasons.push(`${role}:unexpected_verdict`);
        if (role === 'oracle') oracleRun = run;
      }
      if (reasons.length === 0 && oracleRun) {
        const oracle = runs[0];
        const plans = structuredClone(await ports.mutations({ scenario: structuredClone(input.scenario), oracleGrade: structuredClone(oracle.grade) }));
        const targets = oracle.grade.checks.filter(c => c.rewardBearing).map(c => c.id);
        if (plans.length > 200 || new Set(plans.map(p => p.id)).size !== plans.length || plans.some(p => !p.id || !targets.includes(p.targetCheckId)) || targets.some(id => !plans.some(p => p.targetCheckId === id))) {
          reasons.push('mutation:missing_or_invalid_coverage');
        } else for (const plan of plans) {
          const key = `${input.replayKey}/mutation/${plan.id}`;
          const fork = await ports.mutate({ oracleRun, oracleExecution: structuredClone(oracle.execution), plan: structuredClone(plan), key });
          const run = register(fork.run), execution = structuredClone(fork.execution);
          const grade = structuredClone(await ports.grade({ run, execution: structuredClone(execution), scenario: structuredClone(input.scenario) }));
          mutations.push({ plan, runId: run.runId, execution, grade });
          if (!validExecution(execution, true, input.qualityCostPolicy) || !validGrade(grade, requiredGateCheckIds(input.scenario))) { unresolved = true; reasons.push(`mutation:${plan.id}:incomplete`); }
          else if (!grade.checks.some(c => c.id === plan.targetCheckId && c.rewardBearing && c.passed === false)) reasons.push(`mutation:${plan.id}:target_did_not_flip`);
        }
      }
    } catch { unresolved = true; reasons.push('execution:exception_or_unsupported'); }
    finally {
      for (const run of live) try { await run.dispose(); } catch { unresolved = true; reasons.push(`cleanup:${run.runId}:unresolved`); }
    }
    const body = {
      schema: 'sandbox-gate-evidence-v1' as const, executionRule,
      ...(input.qualityCostPolicy ? { qualityCostPolicy: input.qualityCostPolicy } : {}), bindingDigest,
      environmentDigest: gateDigest(input.environment), scenarioDigest: gateDigest(input.scenario),
      scope: input.scope, versions: input.versions,
      status: unresolved ? 'unresolved' as const : reasons.length ? 'rejected' as const : 'passed' as const,
      reasons, runs, mutations,
    };
    return { ...body, digest: gateDigest(body) };
  });
  const { digest, ...body } = result;
  if (result.bindingDigest !== bindingDigest || digest !== gateDigest(body) || (result.status === 'passed' && !passingGateEvidence(result, input.scenario))) throw new Error('Corrupt or conflicting durable gate evidence');
  return structuredClone(result);
}

export interface SuiteGateArtifact {
  schema: 'sandbox-suite-admission-v1';
  scope: GateScope;
  environment: EnvironmentSpec;
  scenarios: SandboxScenario[];
  evidence: ScenarioGateEvidence[];
  digest: string;
}
/** Distinct sandbox artifact: deliberately not accepted by the text frozen12 adapter. */
export function createSuiteGateArtifact(input: { scope: GateScope; environment: EnvironmentSpec; scenarios: SandboxScenario[]; evidence: ScenarioGateEvidence[] }): SuiteGateArtifact {
  const snapshot = structuredClone({ scope: input.scope, environment: input.environment, scenarios: input.scenarios, evidence: input.evidence });
  if (!snapshot.scenarios.length || new Set(snapshot.scenarios.map(s => s.id)).size !== snapshot.scenarios.length || snapshot.evidence.length !== snapshot.scenarios.length) throw new Error('Invalid suite');
  snapshot.scenarios.forEach((scenario, index) => {
    const e = snapshot.evidence[index], { digest, ...body } = e;
    assertInput({ ...snapshot, scenario, versions: e.versions, replayKey: 'verify' });
    if (!passingGateEvidence(e, scenario) || digest !== gateDigest(body) || e.environmentDigest !== gateDigest(snapshot.environment) || e.scenarioDigest !== gateDigest(scenario) || e.bindingDigest !== gateDigest(binding({ ...snapshot, scenario, versions: e.versions, replayKey: 'verify', qualityCostPolicy: e.qualityCostPolicy }, e.executionRule))) throw new Error('Missing exact passing gate evidence');
  });
  const body = { schema: 'sandbox-suite-admission-v1' as const, ...snapshot };
  return { ...body, digest: gateDigest(body) };
}
export interface CustomerSuiteApproval {
  /** Immutable trusted customer-approved quality cap; absent means no cost reward gate. */
  qualityCostPolicy?: GateQualityCostPolicy;
  decision: 'approved' | 'rejected' | 'pending';
  suiteDigest: string;
  environmentDigest: string;
  evidenceDigest: string;
  scope: GateScope;
  customerId: string;
  approvalId: string;
}
export interface CustomerApprovalPort {
  /** Authorize the caller and load immutable server-held decision. Never accept model/request
   * approval payloads. Conflicting replacements must fail atomically in durable storage. */
  resolve(input: { scope: GateScope; suiteDigest: string }): Promise<CustomerSuiteApproval | null>;
}
export async function admitApprovedSandboxSuite(raw: SuiteGateArtifact, approvals: CustomerApprovalPort): Promise<{ artifact: SuiteGateArtifact; approval: CustomerSuiteApproval }> {
  const artifact = structuredClone(raw);
  const expected = createSuiteGateArtifact({ scope: artifact.scope, environment: artifact.environment, scenarios: artifact.scenarios, evidence: artifact.evidence });
  if (artifact.schema !== 'sandbox-suite-admission-v1' || artifact.digest !== expected.digest) throw new Error('Suite artifact changed');
  const approval = structuredClone(await approvals.resolve({ scope: structuredClone(artifact.scope), suiteDigest: artifact.digest }));
  if (approval && approval.qualityCostPolicy !== undefined && !validGateQualityCostPolicy(approval.qualityCostPolicy)) throw new Error('Invalid approved quality cost policy');
  if (!approval || approval.decision !== 'approved' || !approval.customerId || !approval.approvalId
    || approval.suiteDigest !== artifact.digest || approval.environmentDigest !== gateDigest(artifact.environment)
    || approval.evidenceDigest !== gateDigest(artifact.evidence) || canonicalJson(approval.scope) !== canonicalJson(artifact.scope)) throw new Error('Customer approval absent, pending, rejected or stale');
  return { artifact, approval };
}
