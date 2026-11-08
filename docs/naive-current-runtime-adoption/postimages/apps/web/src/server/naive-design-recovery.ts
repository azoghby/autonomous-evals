import 'server-only';
import { createHash } from 'node:crypto';
import { FatalError } from 'workflow';
import { IntakeInput, type IntakeInput as Intake } from '@ae/core/contracts/index';
import { textDesignTaskScope } from '@ae/core/evals/text/design';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { normalizeReferenceText } from '@ae/core/evals/text/schema';
import type { JobRef } from '@ae/core/evals/types';
import { resolveJobNaiveExecution } from './naive-text-execution-runtime';
import { isWorkflowStagePendingError } from './services';
import type { LogicalWorkflowStage } from './workflow-stage-runtime';
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
/** Resolve immutable, code-derived scope before paid stage admission. No provider construction. */
export async function naiveDesignRecoveryStage(jobId:string,intake:Intake,selected:Awaited<ReturnType<typeof resolveJobNaiveExecution>>):Promise<LogicalWorkflowStage> {
 if(!selected.generic||process.env.EVAL_SERVICES!=='real')throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 const row=(await selected.sql.query<{customer_id:string;environment:'test'|'live';intake:unknown;retest_of_job_id:string|null}>(`SELECT customer_id::text,environment,intake,retest_of_job_id::text FROM jobs WHERE id=$1 AND package='text_eval' AND NOT is_mock AND state IN ('planning','running','investigating')`,[jobId])).rows[0];
 if(!row||row.customer_id!==selected.identity.customerId||row.environment!==selected.identity.environment)throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 const stored=IntakeInput.parse(row.intake);
 const clean=(v:Intake)=>{if(v.package!=='text_eval')throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');const {apiKey:_key,...endpoint}=v.endpoint;return {...v,endpoint};};
 if(canonicalJson(clean(stored))!==canonicalJson(clean(intake)))throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 if(stored.package!=='text_eval')throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 const job:JobRef={jobId,customerId:row.customer_id,environment:row.environment,package:'text_eval',isFixture:false,quoteVersion:null,linkedRetestOf:row.retest_of_job_id};
 const {designId,versionLabel}=selected.profile;
 const designInput={versionLabel,systemPrompt:stored.endpoint.systemPrompt,referenceText:normalizeReferenceText(stored.endpoint.referenceText??null),...('factualGapPolicy' in selected.profile?{factualGapPolicy:selected.profile.factualGapPolicy}:{})};
 const expectedChildPlan={profile:'naive-design-v1' as const,scope:textDesignTaskScope({job,...designInput}),outerDesignId:designId,inputDigest:hash({environment:job.environment,input:{suiteId:designId,...designInput}})};
 return {key:'suite-design',input:{intake:clean(stored),redTeam:false,executionProfile:selected.profile,expectedChildPlan},recovery:'naive-design-v1',expectedChildPlan,isPendingError:isWorkflowStagePendingError};
}
