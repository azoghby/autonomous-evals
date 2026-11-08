import { WorkflowStageContentionError } from '@/server/workflow-stage-runtime';
import { expertOwnerDatabase } from '@/server/automated-expert-owner';
import { createExpertTextRuntime } from '@/server/expert-text-runtime';
import { recordProgress, setJobState } from '@/server/job-store';
import { withBudget, loadIntake } from './common';
import { stageRealEvalServices as evalServices } from '@/server/services';
import { Report } from '@ae/core/contracts/index';
import { persistReport } from './evaluate';
import { TrackBPendingError } from '@ae/core/evals/service-adapter';
import type { Suite, Finding } from '@ae/core/contracts/index';

export type ExpertTextOutcome = {status:'pending'} | {status:'budget_exceeded';message:string} | {status:'ok';data:{suite:Suite;findings:Finding[]}};
/** Existing job owns scheduling/payment/report/delivery. This step only consumes its canonical reviewed suite. */
export async function expertTextEvaluationStep(jobId:string):Promise<ExpertTextOutcome> {
 'use step';
 const stage=await expertStage(jobId,'evaluation');
 try {
  return await withBudget(jobId,'investigator',stage,async ctx=>{
   const runtime=await createExpertTextRuntime(ctx);
   await runtime.assertCurrent();
   await setJobState(jobId,'running');
   await runtime.assertCurrent();
   await recordProgress(jobId,'running_suite','Running the reviewed frozen suite against your endpoint.');
   const run=await runtime.run();
   await runtime.assertCurrent(run);
   await setJobState(jobId,'investigating');
   await runtime.assertCurrent();
   const findings=await runtime.investigate(run);
   await runtime.assertCurrent(findings);
   await recordProgress(jobId,'investigated',`Investigation produced ${findings.length} finding(s). Rich assessment evidence is retained privately.`);
   const assessment=await runtime.reportContext();
   if(assessment.assessed===0)throw new Error('expert_text_no_assessment');
   return {suite:runtime.suite,findings};
  });
 }catch(error){
  if(error instanceof WorkflowStageContentionError)throw error;
  // Durable provider polling and ambiguous transport reconciliation retain the paid Workflow.
  // Never route this explicit expert plan through the lite or legacy evaluator.
  if(error instanceof TrackBPendingError)return {status:'pending'};
  await recordProgress(jobId,'expert_text_pending','Evaluation is awaiting current authorization, runtime configuration, or durable reconciliation.');
  return {status:'pending'};
 }
}
expertTextEvaluationStep.maxRetries=0;

/** Direct existing Naive operator service; explicit text plans never enter withLiteFallback. */
export async function expertTextReportStep(jobId:string,findings:Finding[],suite:Suite) {
 'use step';
 return withBudget(jobId,'operator',await expertStage(jobId,'report'),async ctx=>{
  const runtime=await createExpertTextRuntime(ctx);
  const assessment=await runtime.reportContext();
  if(!assessment.assessed)throw new Error('expert_text_no_assessment');
  const intake=await loadIntake(jobId,false);
  await runtime.assertCurrent({findings,suite});
  const report=Report.parse(await evalServices.renderReport(ctx,{intake,findings,suite,remediations:[]}));
  await runtime.assertCurrent(report);
  const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  report.markdown+=`\n\n## Assessment coverage and limitations\n\n${assessment.summary}\n`;
  report.html+=`<section><h2>Assessment coverage and limitations</h2><pre>${escape(assessment.summary)}</pre></section>`;
  report.summary=`${assessment.summary}\n\n${report.summary}`.slice(0,10000);
  await runtime.assertCurrent(report);
  // Existing private Blob/SQL/report flow remains the publication mechanism.
  await persistReport(jobId,report,suite);
  await runtime.assertCurrent(report);
  return true;
 });
}
expertTextReportStep.maxRetries=0;

/** Poll steps select the same retained task; Workflow step IDs and retry counts never change its identity. */
async function expertStage(jobId:string,phase:string) {
 const row=(await expertOwnerDatabase().query<{input:{task:{taskId:string}};input_digest:string}>(
  'SELECT input,input_digest FROM expert_workflow.plans WHERE job_id=$1',[jobId])).rows[0];
 if(!row?.input.task.taskId||!row.input_digest)throw new Error('expert_text_stage_identity_unavailable');
 return {key:`expert-text:${phase}:${row.input.task.taskId}`,input:{taskId:row.input.task.taskId,requestDigest:row.input_digest},isPendingError:(error:unknown)=>error instanceof TrackBPendingError};
}
