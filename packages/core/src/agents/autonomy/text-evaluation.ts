import { createAutonomousDataAdmission, type AutonomousDataRequest } from '../../evals/data/autonomy';
import { reviewDigest } from '../../evals/data/binding';
import type { DataOperationLedger } from '../../evals/data/operation-ledger';
import { designTextSuite } from '../../evals/text/design';
import { executeSuite } from '../../evals/text/execute';
import { investigateTextRun } from '../../evals/text/investigate';
import type { TextExecutionDeps } from '../../evals/text/schema';
import type { AgentTaskRunner } from '../session-service';
import type { JobRef } from '../../evals/types';
import { CompanyEvaluationPendingError, type CompanyEvaluation } from './company';

/** Additive autonomous path: never manufactures human review fields or weakens legacy admission.
 * Target/judge dependencies must already implement durable budget/authorization/receipt guards. */
export function createAutonomousTextEvaluation(config: {
  job: JobRef; request: AutonomousDataRequest; admission: ReturnType<typeof createAutonomousDataAdmission>;
  operations: DataOperationLedger; runner: AgentTaskRunner; execution: TextExecutionDeps;
  versionLabel: string; systemPrompt: string | null; now(): Date;
}) {
  const request = structuredClone(config.request);
  if (config.job.jobId !== request.task.jobId || config.job.customerId !== request.tenantId || config.job.package !== 'text_eval') throw new Error('autonomous_text_scope');
  const adapter = {
    async evaluate(key: string, dataDigest: string): Promise<CompanyEvaluation> {
      const decision = await config.admission.admit({...request,now:config.now().toISOString()});
      if (decision.status !== 'ready' || decision.requestDigest !== dataDigest) throw new Error('autonomous_text_data_refused');
      const sourceIds = new Set(decision.approvedFacts.flatMap(f => f.sourceIds));
      const referenceText = request.candidates.sources.filter(s => sourceIds.has(s.id)).map(s => s.content).join('\n\n');
      if (!referenceText) throw new Error('autonomous_text_reference_missing');
      const design = await designTextSuite({job:config.job,versionLabel:config.versionLabel,systemPrompt:config.systemPrompt,referenceText}, {runner:config.runner,now:config.now});
      if (design.status !== 'completed') {
        if(design.agentOutcome?.status === 'pending') throw new CompanyEvaluationPendingError('agent_pending');
        throw new Error(`autonomous_design_${design.reason}`);
      }
      const intentKey=`${key}:target-dispatch`, intentDigest=reviewDigest({suite:design.suite.digest,dataDigest});
      const intent=await config.operations.claim(intentKey,intentDigest);
      if(!intent.claimed)throw new Error('autonomous_target_receipt_required');
      const runId = `auto-${reviewDigest(key).slice(0,24)}`;
      const run = await executeSuite(design.suite,runId,config.execution);
      const investigation = await investigateTextRun({job:config.job,suite:design.suite,run}, {...config.execution,runner:config.runner});
      const result: CompanyEvaluation = {
        findings:investigation.findings, limitations:[...investigation.limitations,'Automated data authority covers only configured exact facts; passing objective checks does not assess general factual correctness.'],
        reportArtifactId:`report-${reviewDigest(key).slice(0,24)}`, evidenceDigest:reviewDigest(run),suiteDigest:design.suite.digest,
        knownCostMicroUsd:[...design.costs,...investigation.costs].reduce((n,c)=>n+c.microUsd,0),
        unknownCosts:['Customer target provider usage',...(!config.execution.judge ? ['Rubric judge unavailable: rubric results remain unassessed'] : [])],
      };
      const artifact = {result,dataAuthority:decision,suite:design.suite,run,investigation};
      const digest=reviewDigest(artifact), artifactKey=`${key}:retained-artifact`;
      await config.operations.claim(artifactKey,digest); await config.operations.complete(artifactKey,digest,artifact);
      return result;
    },
    async recoverEvaluation(key: string): Promise<CompanyEvaluation|null> {
      // Recheck current evidence authority; retained results do not expand expired permission.
      const decision=await config.admission.admit({...request,now:config.now().toISOString()});
      if(decision.status!=='ready')return null;
      const row=await config.operations.get(`${key}:retained-artifact`);
      if(row?.state==='complete')return (row.result as {result:CompanyEvaluation}).result;
      // Existing agent tasks may be polled/re-entered safely before any target dispatch intent.
      // Once a target could have spent money, only a retained authoritative result can resume.
      if(!await config.operations.get(`${key}:target-dispatch`)) return adapter.evaluate(key,decision.requestDigest);
      return null;
    },
  };
  return adapter;
}
