import { createExpertTextRuntime } from '@/server/expert-text-runtime';
import { recordProgress, setJobState } from '@/server/job-store';
import { withBudget, loadIntake } from './common';
import { evalServices } from '@ae/core/integration/eval-services';
import { Report } from '@ae/core/contracts/index';
import { persistReportStep } from './evaluate';
import { TrackBPendingError } from '@ae/core/evals/service-adapter';
import type { Suite, Finding } from '@ae/core/contracts/index';

export type ExpertTextOutcome = {status:'pending'} | {status:'budget_exceeded';message:string} | {status:'ok';data:{suite:Suite;findings:Finding[]}};
/** Existing job owns scheduling/payment/report/delivery. This step only consumes its canonical reviewed suite. */
export async function expertTextEvaluationStep(jobId:string):Promise<ExpertTextOutcome> {
 'use step';
 try {
  return await withBudget(jobId,'investigator',async ctx=>{
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
 return withBudget(jobId,'operator',async ctx=>{
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
  await persistReportStep(jobId,report,suite);
  await runtime.assertCurrent(report);
  return true;
 });
}
expertTextReportStep.maxRetries=0;
