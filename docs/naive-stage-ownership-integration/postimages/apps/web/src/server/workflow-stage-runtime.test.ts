import { beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({claim:vi.fn(),recover:vi.fn(),complete:vi.fn(),pending:vi.fn(),assert:vi.fn(),metadata:{stepId:'step-a',attempt:0},payload:undefined as unknown}));
vi.mock('workflow',()=>({getStepMetadata:()=>state.metadata,getWorkflowMetadata:()=>({workflowRunId:'run'}),RetryableError:class extends Error{}}));
vi.mock('@neondatabase/serverless',()=>({Pool:class{async connect(){return {query:async()=>({rows:[]}),release(){}};}}}));
vi.mock('@ae/core/db/job-budget-authority',()=>({jobBudgetExposure:async()=>({capMicroUsd:100})}));
vi.mock('./workflow-stage-children',()=>({workflowStageRecoveryReader:{read:vi.fn()}}));
vi.mock('@ae/core/db/workflow-stage-authority',()=>({claimWorkflowStage:state.claim,recoverWorkflowStage:state.recover,assertWorkflowStageOwner:state.assert,completeWorkflowStage:state.complete,markWorkflowStagePending:state.pending}));
vi.mock('@ae/core/storage/crypto',()=>({encryptJson:(v:unknown)=>JSON.stringify(v),decryptJson:(v:string)=>JSON.parse(v)}));
import { executeWorkflowStage, currentWorkflowStageScope, workflowStageDigest, WorkflowStageContentionError } from './workflow-stage-runtime';
const input={jobId:'job',ownerId:'owner',environment:'test' as const,role:'judge',share:.5,stage:{key:'suite-run:A:v1',input:{suite:'frozen',target:'digest'}}};
beforeEach(()=>{process.env.DATABASE_URL='postgres://local/test';vi.clearAllMocks();state.claim.mockResolvedValue({kind:'owned',owner:{jobId:'job',stageKey:input.stage.key,token:'private',generation:1},amountMicroUsd:50});});
it('records SDK retry evidence without changing logical identity or passing it to child callback',async()=>{
 state.metadata.attempt=3;const run=vi.fn(async amount=>{expect(currentWorkflowStageScope()?.owner.generation).toBe(1);return amount;});
 expect(await executeWorkflowStage(input,run)).toEqual({ok:true,data:50});
 expect(state.claim.mock.calls[0][1]).toMatchObject({stageKey:input.stage.key,invocation:{stepId:'step-a',attempt:3}});
 expect(run).toHaveBeenCalledWith(50);expect(currentWorkflowStageScope()).toBeUndefined();expect(state.complete).toHaveBeenCalledOnce();
});
it.each(['busy','recovery_required'])('does not invoke callback when %s',async kind=>{
 state.claim.mockResolvedValue({kind});const run=vi.fn();await expect(executeWorkflowStage(input,run)).rejects.toBeInstanceOf(WorkflowStageContentionError);expect(run).not.toHaveBeenCalled();
});
it('retains pending child and hold on normal pending outcome',async()=>{
 await executeWorkflowStage({...input,stage:{...input.stage,isPending:v=>(v as {status:string}).status==='pending'}},async()=>({status:'pending'}));
 expect(state.pending).toHaveBeenCalledOnce();expect(state.complete).not.toHaveBeenCalled();
});
it('retains explicit provider pending error without completing the envelope',async()=>{
 const pending=new Error('pending');await expect(executeWorkflowStage({...input,stage:{...input.stage,isPendingError:e=>e===pending}},async()=>{throw pending;})).rejects.toBe(pending);
 expect(state.pending).toHaveBeenCalledOnce();expect(state.complete).not.toHaveBeenCalled();
});
it('replays bound retained completion across poll step IDs without provider dispatch',async()=>{
 const retained={schema:1,jobId:input.jobId,stageKey:input.stage.key,inputDigest:workflowStageDigest(input.stage.input),data:{value:'retained'}};
 state.claim.mockResolvedValue({kind:'completed',resultCiphertext:JSON.stringify(retained)});state.metadata.stepId='later-poll';const run=vi.fn();
 expect(await executeWorkflowStage(input,run)).toEqual({ok:true,data:retained.data});expect(run).not.toHaveBeenCalled();
 state.claim.mockResolvedValue({kind:'completed',resultCiphertext:JSON.stringify({...retained,stageKey:'other'})});
 await expect(executeWorkflowStage(input,run)).rejects.toThrow('workflow_stage_result_binding');
});
it('uses stable input digests and distinguishes target slot and revision inputs',()=>{
 expect(workflowStageDigest({a:1,b:2})).toBe(workflowStageDigest({b:2,a:1}));
 expect(workflowStageDigest({slot:'A',revision:1})).not.toBe(workflowStageDigest({slot:'B',revision:1}));
});

it('holds mixed or unclassified callbacks even when retained children could recover',async()=>{
 state.claim.mockResolvedValue({kind:'recovery_required'});
 state.recover.mockResolvedValue({kind:'owned',owner:{jobId:'job',stageKey:input.stage.key,token:'replacement',generation:2},amountMicroUsd:50});
 const run=vi.fn();
 await expect(executeWorkflowStage(input,run)).rejects.toBeInstanceOf(WorkflowStageContentionError);
 expect(state.recover).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
it('requires explicit complete child coverage before consulting recovery authority',async()=>{
 state.claim.mockResolvedValue({kind:'recovery_required'});
 state.recover.mockResolvedValue({kind:'recovery_required'});
 const run=vi.fn();
 await expect(executeWorkflowStage({...input,stage:{...input.stage,recovery:'retained-children'}},run)).rejects.toBeInstanceOf(WorkflowStageContentionError);
 expect(state.recover).toHaveBeenCalledOnce();expect(run).not.toHaveBeenCalled();
});

it('binds retained completion to admission digest even if a callback mutates its local input',async()=>{
 const value={suite:'original'};const expected=workflowStageDigest(value);
 await executeWorkflowStage({...input,stage:{key:'mutation',input:value}},async()=>{value.suite='mutated';return 'done';});
 expect(state.claim.mock.calls[0][1].inputDigest).toBe(expected);
 expect(JSON.parse(state.complete.mock.calls[0][2]).inputDigest).toBe(expected);
});
