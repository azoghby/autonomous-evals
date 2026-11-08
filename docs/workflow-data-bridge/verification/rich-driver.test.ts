import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ api:null as any,persist:vi.fn(),artifact:vi.fn(),progress:vi.fn() }));
vi.mock('@/server/rich-services',()=>({createRichWorkflowServices:async()=>state.api,workflowSql:()=>({query:async()=>({rows:[]})})}));
vi.mock('@/server/rich-artifacts',()=>({persistRichArtifact:(...a:unknown[])=>state.artifact(...a)}));
vi.mock('@/server/job-store',()=>({getJob:async()=>({workflowRunId:'workflow',state:'planning',isMock:false,package:'text_eval'}),setJobState:vi.fn(),recordProgress:(...a:unknown[])=>state.progress(...a)}));
vi.mock('@step-evaluate',()=>({persistReportStep:(...a:unknown[])=>state.persist(...a),createBranchStep:vi.fn()}));
vi.mock('@step-common',()=>({withBudget:async(_j:string,_a:string,run:any)=>({status:'ok',data:await run({jobId:'job',environment:'test'})})}));
import { richEvaluationStep } from '@rich-step';
beforeEach(()=>{
 vi.clearAllMocks();process.env.REDTEAM_PACK='off';
 const suite={digest:'a'.repeat(64),scenarios:Array.from({length:12},(_,i)=>({id:`s${i}`}))};
 state.api={job:{jobId:'job',customerId:'tenant',environment:'test'},intake:{package:'text_eval',endpoint:{systemPrompt:'prompt'}},knownSecrets:[],
  inventory:{touch:vi.fn(),phase:async(_a:unknown,run:any)=>run(),acquisition:vi.fn()},advanceData:vi.fn(async()=>null),approvedData:vi.fn(),
  text:{getSuite:vi.fn(async()=>suite),designSuite:vi.fn(async()=>({status:'completed',suite})),runSuite:vi.fn(async()=>({runId:'run:job:baseline',executions:[{checks:[{status:'not_assessed'}]}]})),investigate:vi.fn(async()=>({investigatorStatus:'completed',findings:[],limitations:[]})),reportInput:vi.fn(async()=>({richFindings:[],limitations:['Unassessed factual correctness']}))},
  bindTextBaseline:vi.fn(),renderReport:vi.fn(async()=>({markdown:'Unassessed',findings:[]})),dispose:vi.fn()};
});
it.each([['waiting_for_data','pending'],['waiting_for_review','pending'],['cost_delivery_pending','pending'],['reconciliation_required','needs_operator'],['mapping_blocked','needs_operator']])('actual rich driver blocks %s before suite/target/report',async(status,outcome)=>{
 state.api.advanceData.mockResolvedValue({status,task:{spec:{taskId:'task'}}});
 expect(await richEvaluationStep('job','workflow')).toBe(outcome);
 for(const fn of ['getSuite','designSuite','runSuite','investigate','reportInput'])expect(state.api.text[fn]).not.toHaveBeenCalled();
 expect(state.persist).not.toHaveBeenCalled();expect(state.artifact).not.toHaveBeenCalled();expect(state.api.dispose).toHaveBeenCalledOnce();
});
it('uses supported exact approved-suite lookup and retains full provenance without another design',async()=>{
 const suite=await state.api.text.getSuite();state.api.text.getSuite.mockClear();
 const provenance={taskId:'task',referenceDigest:'b'.repeat(64),sourceIds:['reviewed-source'],caseIds:['approved-case'],privateApproval:{receipt:'retained'}};
 state.api.advanceData.mockResolvedValue({status:'ready',frozen:{suite,provenance}});state.api.approvedData.mockResolvedValue({suite,provenance});
 expect(await richEvaluationStep('job','workflow')).toBe('complete');
 expect(state.api.approvedData).toHaveBeenCalledWith({jobId:'job',environment:'test'},suite.digest);expect(state.api.text.getSuite).toHaveBeenCalledWith({jobId:'job',environment:'test'},suite.digest);
 expect(state.api.text.designSuite).not.toHaveBeenCalled();expect(state.api.text.runSuite).toHaveBeenCalledWith({jobId:'job',environment:'test'},{suiteDigest:suite.digest,runId:'run:job:baseline'});
 expect(state.artifact.mock.calls[0][3].dataProvenance).toEqual(provenance);expect(state.artifact.mock.calls[0][3].run.executions[0].checks[0].status).toBe('not_assessed');expect(state.persist).toHaveBeenCalledOnce();
});
it('ready without supported admission cannot run or silently design',async()=>{
 state.api.advanceData.mockResolvedValue({status:'ready',frozen:{suite:{digest:'a'.repeat(64)}}});state.api.approvedData.mockResolvedValue(null);
 expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');expect(state.api.text.designSuite).not.toHaveBeenCalled();expect(state.api.text.runSuite).not.toHaveBeenCalled();expect(state.persist).not.toHaveBeenCalled();
});
it('keeps standalone design available only for an absent data plan',async()=>{
 expect(await richEvaluationStep('job','workflow')).toBe('complete');expect(state.api.text.designSuite).toHaveBeenCalledOnce();expect(state.api.approvedData).not.toHaveBeenCalled();
});
