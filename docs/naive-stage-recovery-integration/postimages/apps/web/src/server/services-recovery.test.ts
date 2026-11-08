import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn(()=>({qualify:vi.fn(),auditTrace:vi.fn(),renderReport:vi.fn()})),sessions:vi.fn(),runner:vi.fn()}));
vi.mock('./workflow-stage-children',()=>({fenceWorkflowStageSessions:mocks.sessions,fenceWorkflowStageRunner:mocks.runner}));
vi.mock('@ae/core/integration/eval-services',async original=>({...await original<typeof import('@ae/core/integration/eval-services')>(),createRealEvalServices:mocks.create}));
afterEach(()=>vi.unstubAllEnvs());
it('binds every supported real callback to its raw primary and single retained child profile',async()=>{
 const {recoverableEvalStage,stageRealEvalServices}=await import('./services');
 for(const method of ['qualify','auditTrace','renderReport'] as const){
  vi.stubEnv('EVAL_SERVICES','real');
  const key=method==='qualify'?'qualification:0':method==='auditTrace'?'trace-audit':'report';
  const expectedChildKey=method==='qualify'?'job:commercial:qualify_r0:1':method==='auditTrace'?'job:quality_investigator:trace_recheck:1':'job:company_operator:report_summary:1';
  const selected=await recoverableEvalStage(method,'job',key,{value:1});
  expect(selected.services).toBe(stageRealEvalServices);
  expect(selected.stage).toMatchObject({key,input:{serviceMode:'real',method,input:{value:1}},recovery:'naive-single-child-v1',expectedChildKey});
  const {TrackBPendingError}=await import('@ae/core/integration/eval-services');
  expect(selected.stage.isPendingError?.(new TrackBPendingError(5000,'running'))).toBe(true);
  expect(selected.stage.isPendingError?.(new Error('unknown'))).toBe(false);
 }
});
it('keeps lite and mock callbacks outside the recovery profile and binds mode into input',async()=>{
 const {recoverableEvalStage,stageRealEvalServices}=await import('./services');
 for(const mode of ['lite','mock']){
  vi.stubEnv('EVAL_SERVICES',mode);
  const selected=await recoverableEvalStage('qualify','job','qualification:0',{});
  expect(selected.services).not.toBe(stageRealEvalServices);
  expect(selected.stage.input).toEqual({serviceMode:mode,method:'qualify',input:{}});
  expect(selected.stage.recovery).toBeUndefined();
  expect(selected.stage.isPendingError).toBeUndefined();
 }
});
it('exposes raw pending until the complete stage promise rejects, then converts to Workflow retry',async()=>{
 const {recoverableEvalStage,workflowServiceCall}=await import('./services');
 const {TrackBPendingError}=await import('@ae/core/integration/eval-services');
 const {RetryableError}=await import('workflow');
 vi.stubEnv('EVAL_SERVICES','real');
 const selected=await recoverableEvalStage('qualify','job','qualification:0',{});
 let pendingRecorded=false;
 await expect(workflowServiceCall(async()=>{
  const raw=new TrackBPendingError(5000,'running');
  pendingRecorded=selected.stage.isPendingError?.(raw)===true;
  throw raw;
 })).rejects.toBeInstanceOf(RetryableError);
 expect(pendingRecorded).toBe(true);
});
it('never routes a real profile primary failure through lite fallback',async()=>{
 const {recoverableEvalStage,stageRealEvalServices}=await import('./services');
 const {EvalServiceUnavailableError}=await import('@ae/core/integration/eval-services');
 vi.stubEnv('EVAL_SERVICES','real');
 const selected=await recoverableEvalStage('qualify','job','qualification:0',{});
 const error=new EvalServiceUnavailableError('qualify','unexpected primary gap');
 vi.mocked(stageRealEvalServices.qualify).mockRejectedValueOnce(error);
 await expect(selected.services.qualify({} as never,{} as never,[])).rejects.toBe(error);
});

it('rejects mismatched methods, malformed rounds and unsafe round identities',async()=>{
 const {recoverableEvalStage}=await import('./services');
 for(const [method,key] of [['qualify','report'],['qualify','qualification:01'],['qualify','qualification:-1'],['qualify','qualification:9007199254740992'],['auditTrace','qualification:0'],['renderReport','trace-audit']] as const){
  await expect(recoverableEvalStage(method,'job',key,{})).rejects.toThrow('workflow_stage_recovery_profile_invalid');
 }
});
