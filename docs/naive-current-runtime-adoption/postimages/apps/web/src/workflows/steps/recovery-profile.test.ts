import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({select:vi.fn(),qualify:vi.fn(async()=>({decision:'quote'})),audit:vi.fn(async()=>({findings:[]})),report:vi.fn(async()=>({summary:'ok'})),budget:vi.fn(),progress:vi.fn(),intake:{package:'trace_audit',trace:'supplied trace'}}));
vi.mock('workflow',()=>({FatalError:class extends Error{}}));
vi.mock('@/server/workflow-stage-runtime',()=>({assertWorkflowStageCurrent:vi.fn()}));
vi.mock('@ae/core/db/client',()=>({db:()=>({}),schema:{}}));
vi.mock('@ae/core/storage/blob',()=>({putJobArtifact:vi.fn()}));
vi.mock('@/server/job-store',()=>({createQuote:vi.fn(),makeServiceContext:vi.fn(),recordProgress:h.progress,setJobState:vi.fn(),findingRowIdByKey:vi.fn(),saveFindings:vi.fn(),saveRemediation:vi.fn()}));
vi.mock('./common',()=>({loadIntake:async()=>h.intake,requireJob:async()=>({package:'trace_audit'}),withBudget:h.budget}));
vi.mock('@/server/services',()=>({getEvalServices:vi.fn(),recoverableEvalStage:h.select,workflowServiceCall:async(fn:()=>Promise<unknown>)=>fn()}));
import {qualifyStep} from './quote';
import {auditTraceStep,renderReportStep} from './evaluate';
beforeEach(()=>{
 vi.clearAllMocks();
 h.select.mockImplementation(async(method,jobId,key,input)=>({services:{qualify:h.qualify,auditTrace:h.audit,renderReport:h.report},stage:{key,input}}));
 h.budget.mockImplementation(async(_job,_role,_stage,run)=>({status:'ok',data:await run({recordProgress:h.progress})}));
});
it('routes every covered callback through its exact immutable child identity',async()=>{
 await qualifyStep('job',[]);
 await auditTraceStep('job');
 await renderReportStep('job',[]);
 expect(h.select.mock.calls.map(c=>[c[0],c[1],c[2]])).toEqual([
  ['qualify','job','qualification:0'],
  ['auditTrace','job','trace-audit'],
  ['renderReport','job','report'],
 ]);
 expect(h.qualify).toHaveBeenCalledTimes(1);expect(h.audit).toHaveBeenCalledTimes(1);expect(h.report).toHaveBeenCalledTimes(1);
});
it('a clarification answer selects a deliberate different qualification child',async()=>{
 await qualifyStep('job',['answer']);
 expect(h.select).toHaveBeenCalledWith('qualify','job','qualification:1',{intake:h.intake,clarifications:['answer']});
});
