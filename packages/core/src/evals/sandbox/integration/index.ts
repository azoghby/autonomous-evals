import type { EvalVersions, EnvironmentSpec, SandboxScenario } from '../../../sandbox/spec';
import { freezeSandboxInputs, verifySandboxInputs } from '../identity';
import { createSandboxGenerationAdapter, type SandboxGenerationConfig, type SandboxGenerationRequest } from '../generation/adapter';
import { admitApprovedSandboxSuite, createSuiteGateArtifact, gateDigest, runScenarioGates, type CustomerApprovalPort, type GatePorts, type GateReplayPort, type GateScope, type GateVersions, type SuiteGateArtifact, type ScenarioGateEvidence } from '../generation/gates';
import { executeToolLoopTrial, executionDigest, type ExecutionPorts, type TrialArtifact, type TrialInput } from '../execution/runner';
import { gradeSandbox, type GradeInput, type GradeResult, type GradingRun } from '../grading';
import { summarizeRepeats, type StatisticalTrial } from '../grading/statistics';
import { bridgeGateGrade } from './gate-bridge';

export type GradingEvidence = Omit<GradeInput, 'scenario' | 'run' | 'transcript' | 'versions'>;
export interface FinalSnapshot {
  /** Retained immutable final SQL world, captured BEFORE execution disposes its run.
   * Must not reconstruct rows from StateDiff.sample or use the customer's live DB. */
  run: GradingRun;
  evidence: GradingEvidence;
  release(): Promise<void>;
}
export interface SandboxEngineAuthority {
  /** Reauthorize every call, including completed replay; bind caller/customer/job scope. */
  authorize(input: { scope: GateScope; suiteDigest: string | null; operation: 'generate' | 'propose' | 'run' }): Promise<boolean>;
  /** Durable atomic fence; pending effects require reconciliation, never redispatch. */
  replay: GateReplayPort;
  finalSnapshot(artifact: TrialArtifact): Promise<FinalSnapshot>;
  /** Owner-only durable upsert by execution identity; reject changed report content.
   * Report includes private SQL/policy/transcript evidence: never a public DTO. */
  persistPrivateReport(report: PrivateSandboxReport): Promise<void>;
}
export interface SandboxEngineConfig {
  scope: GateScope;
  generation: Omit<SandboxGenerationConfig, 'assessCandidate'>;
  gateVersions: GateVersions;
  gateEvalVersions: EvalVersions;
  gates: Omit<GatePorts, 'grade'>;
  gateEvidence(input: Parameters<GatePorts['grade']>[0]): Promise<GradingEvidence>;
  approvals: CustomerApprovalPort;
  execution: ExecutionPorts;
  authority: SandboxEngineAuthority;
}
export interface PrivateSandboxReport {
  schema: 'sandbox-private-report-v1';
  suiteDigest: string;
  approvalId: string;
  execution: TrialArtifact;
  grade: GradeResult | null;
  outcome: StatisticalTrial;
  unresolved: string[];
  /** Unknown money is not projected as a numeric v1 TrialResult cost. */
  money: TrialArtifact['money'];
}
export interface EngineTrialRequest {
  artifact: SuiteGateArtifact;
  versions: EvalVersions;
  trial: Omit<TrialInput, 'environment' | 'scenario' | 'versions' | 'jobId'> & { scenarioId: string };
}

/** Concrete composition, with no ambient provider/runtime/storage defaults. The server
 * constructs these trusted ports; none may be supplied by model or customer payloads. */
export function createSandboxEngine(config: SandboxEngineConfig) {
  const scope = structuredClone(config.scope), gateVersions = structuredClone(config.gateVersions);
  const job = structuredClone(config.generation.job);
  const gateEvalVersions = structuredClone(config.gateEvalVersions);
  if (job.jobId !== scope.jobId || !scope.environmentId || gateVersions.runtime !== gateEvalVersions.runtime)
    throw new Error('engine_scope_or_runtime_mismatch');
  const authorize = async (operation: 'generate' | 'propose' | 'run', suiteDigest: string | null) => {
    if (!await config.authority.authorize({ scope: structuredClone(scope), suiteDigest, operation })) throw new Error('sandbox_engine_unauthorized');
  };
  const assess = async (environment: EnvironmentSpec, scenario: SandboxScenario, key: string) => {
    const localGates: GatePorts = { ...config.gates, grade: async input => {
      const pinnedScenario = structuredClone(input.scenario);
      const transcript = structuredClone(input.execution.transcript);
      const evidence = await config.gateEvidence(input);
      return bridgeGateGrade(pinnedScenario, await gradeSandbox({ ...evidence, run: input.run,
        scenario: pinnedScenario, transcript,
        versions: { ...gateEvalVersions, envHash: executionDigest(environment), suiteHash: freezeSandboxInputs(environment, [scenario]).suiteHash } }));
    } };
    return runScenarioGates({ environment, scenario, scope, versions: gateVersions, replayKey: key }, localGates);
  };
  const propose = async (raw: { environment: EnvironmentSpec; scenarios: SandboxScenario[]; operationKey: string }) => {
    const input = structuredClone(raw);
    await authorize('propose', null);
    const frozen = verifySandboxInputs(freezeSandboxInputs(input.environment, input.scenarios));
    if (!input.operationKey?.trim()) throw new Error('sandbox_operation_key_missing');
    return config.authority.replay.once(`${scope.jobId}/proposal/${input.operationKey}`, gateDigest({ suiteHash: frozen.suiteHash, gateVersions, gateEvalVersions }), async () => {
      const evidence = [];
      for (const scenario of frozen.scenarios) evidence.push(await assess(frozen.environment, scenario,
        `${scope.jobId}/gate/${input.operationKey}/${scenario.id}`));
      return createSuiteGateArtifact({ scope, environment: frozen.environment, scenarios: [...frozen.scenarios], evidence });
    });
  };
  return {
    propose,
    async generate(raw: SandboxGenerationRequest) {
      const request = structuredClone(raw);
      await authorize('generate', null);
      const accepted = new Map<string, ScenarioGateEvidence>();
      const adapter = createSandboxGenerationAdapter({ ...config.generation, job, assessCandidate: async (candidate, operationKey) => {
        const evidence = await assess(request.environment, candidate.scenario, `${scope.jobId}/generation-gate/${operationKey}/${candidate.provenance.scenarioDigest}`);
        if (evidence.status === 'passed') accepted.set(candidate.provenance.scenarioDigest, evidence);
        return evidence.status === 'passed' ? { status: 'passed' } : evidence.status === 'rejected'
          ? { status: 'rejected', reasons: evidence.reasons } : { status: 'unresolved', reason: evidence.reasons.join(',') };
      } });
      const result = await adapter(request);
      let artifact: SuiteGateArtifact | null = null;
      if (result.status === 'complete' && result.candidates.length) {
        const scenarios = result.candidates.map(c => c.scenario);
        freezeSandboxInputs(request.environment, scenarios);
        const evidence = result.candidates.map(c => accepted.get(c.provenance.scenarioDigest));
        if (evidence.every((e): e is ScenarioGateEvidence => e !== undefined))
          artifact = createSuiteGateArtifact({ scope, environment: request.environment, scenarios, evidence });
      }
      return { ...result, artifact };
    },
    async run(raw: EngineTrialRequest, signal?: AbortSignal): Promise<PrivateSandboxReport> {
      const request = structuredClone(raw);
      await authorize('run', request.artifact.digest);
      if (gateDigest(request.artifact.scope) !== gateDigest(scope)) throw new Error('sandbox_scope_mismatch');
      const { artifact, approval } = await admitApprovedSandboxSuite(request.artifact, config.approvals);
      if (approval.customerId !== job.customerId) throw new Error('sandbox_customer_mismatch');
      if (artifact.evidence.some(e => gateDigest(e.versions) !== gateDigest(gateVersions)))
        throw new Error('sandbox_gate_versions_mismatch');
      const frozen = verifySandboxInputs(freezeSandboxInputs(artifact.environment, artifact.scenarios));
      if (request.versions.envHash !== executionDigest(frozen.environment) || request.versions.suiteHash !== frozen.suiteHash
        || request.versions.runtime !== gateVersions.runtime || request.versions.judgeModel !== gateEvalVersions.judgeModel)
        throw new Error('sandbox_version_mismatch');
      const scenario = frozen.scenarios.find(s => s.id === request.trial.scenarioId);
      if (!scenario) throw new Error('sandbox_scenario_missing');
      const { scenarioId: _, ...trial } = request.trial;
      const input: TrialInput = { ...trial, jobId: scope.jobId, environment: frozen.environment, scenario, versions: request.versions };
      const identity = executionDigest(input);
      const report = await config.authority.replay.once(`${scope.jobId}/integrated-trial/${trial.trialId}`, gateDigest({ input, suite: artifact.digest, approval: approval.approvalId }), async () => {
        const execution = await executeToolLoopTrial(input, config.execution, signal);
        const unresolved: string[] = [];
        let grade: GradeResult | null = null;
        if (execution.status !== 'completed' || execution.infrastructure !== 'known') unresolved.push('execution_incomplete');
        else {
          let snapshot: FinalSnapshot | undefined;
          try {
            snapshot = await config.authority.finalSnapshot(structuredClone(execution));
            if (snapshot.run.runId !== execution.runId) throw new Error('snapshot_run_mismatch');
            grade = await gradeSandbox({ ...snapshot.evidence, run: snapshot.run, scenario,
              transcript: execution.transcript, versions: input.versions });
            if (gateDigest(grade.diff) !== gateDigest(execution.diff) || gateDigest(grade.toolCalls) !== gateDigest(execution.toolCalls)) {
              grade = null; unresolved.push('snapshot_execution_mismatch');
            }
          } catch { unresolved.push('final_snapshot_unavailable'); }
          finally { if (snapshot) try { await snapshot.release(); } catch { unresolved.push('snapshot_release_unknown'); } }
        }
        if (!grade || grade.verdict === 'unknown') unresolved.push('grading_unknown');
        // Execution v1 has no authoritative settlement receipt; never invent known money.
        unresolved.push('cost_unsettled');
        const outcome: StatisticalTrial = { scenarioId: scenario.id, trial: trial.trial, seed: String(trial.seed),
          fixtureHash: gateDigest({ environment: frozen.envHash, fixtureSql: scenario.fixtureSql }), variant: trial.variant,
          agentVersion: gateDigest({ model: trial.agentModel, config: trial.agentConfigDigest }), versions: input.versions,
          status: 'unknown', failureAttribution: 'unknown' };
        return { schema: 'sandbox-private-report-v1' as const, suiteDigest: artifact.digest, approvalId: approval.approvalId,
          execution, grade, outcome, unresolved, money: execution.money };
      });
      if (report.execution.identityDigest !== identity || report.suiteDigest !== artifact.digest || report.approvalId !== approval.approvalId)
        throw new Error('sandbox_report_identity_conflict');
      await config.authority.persistPrivateReport(structuredClone(report));
      return structuredClone(report);
    },
    summarize(reports: readonly PrivateSandboxReport[], expected: number) {
      return summarizeRepeats(reports.map(r => r.outcome), expected);
    },
  };
}
