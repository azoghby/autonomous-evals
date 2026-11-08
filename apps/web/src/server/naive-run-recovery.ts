import 'server-only';
import { createHash } from 'node:crypto';
import { FatalError } from 'workflow';
import { JOB_BUDGET_MICRO_USD, type Suite } from '@ae/core/contracts/index';
import type { EvalServices, ServiceContext } from '@ae/core/contracts/services';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { TrackBPendingError } from '@ae/core/evals/service-adapter';
import { judgeOperationId } from '@ae/core/evals/text/execute';
import { createNaiveMethodAuthority } from './naive-method-authority';
import { createNaiveEngineAdmissionPolicy } from './naive-engine-admission-policy';
import { resolveJobNaiveExecution } from './naive-text-execution-runtime';
import type { LogicalWorkflowStage } from './workflow-stage-runtime';
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Derive the bounded plan from retained admission and current canonical target, without constructing providers. */
export async function naiveRunRecoveryStage(jobId:string,suite:Suite,target:Parameters<EvalServices['runSuite']>[2],slot:string,versionLabel:string,branchId:string|undefined,selected:Awaited<ReturnType<typeof resolveJobNaiveExecution>>):Promise<LogicalWorkflowStage>{
 if(!selected.generic||process.env.EVAL_SERVICES!=='real'||slot!=='endpoint'||branchId!==undefined||versionLabel!=='default')throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 const ctx:ServiceContext={jobId,environment:selected.identity.environment,budgetMicroUsd:JOB_BUDGET_MICRO_USD.text_eval,recordCost:async()=>{},recordProgress:async()=>{}};
 const authority=await createNaiveMethodAuthority(ctx,{sql:selected.sql,executionProfile:selected.profile,...createNaiveEngineAdmissionPolicy(selected.profile)});
 const canonical=await authority.resolveSuite(suite);
 if(canonicalJson(target)!==canonicalJson(canonical.target))throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 const children=canonical.frozen.scenarios.flatMap(scenario=>[
  {kind:'text_run_target' as const,operationKey:hash([canonical.runId,scenario.id])},
  ...scenario.rubricChecks.filter(check=>!((check.assessesFactualCorrectness||check.requiresReference)&&!canonical.frozen.referenceText?.trim())).map(check=>({kind:'text_run_judge' as const,operationKey:judgeOperationId(canonical.frozen.digest,canonical.runId,check.id)})),
 ]);
 const expectedChildPlan={profile:'naive-text-run-v1' as const,runId:canonical.runId,suiteDigest:canonical.frozen.digest,targetVersion:canonical.targetVersion,environment:canonical.job.environment,children};
 return {key:`suite-run:${slot}:${versionLabel}`,input:{executionProfile:selected.profile,expectedChildPlan},recovery:'naive-text-run-v1',expectedChildPlan,isPendingError:error=>error instanceof TrackBPendingError||(error instanceof Error&&/^(NAIVE_OPERATION_PENDING:|NAIVE_ADMISSION_PENDING:)/.test(error.message))};
}
