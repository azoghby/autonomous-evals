import { beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({scope:undefined as any,stale:false,committed:[] as string[],pending:[] as string[],failWrite:false,query:vi.fn()}));
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>state.scope,workflowStageDigest:()=>''}));
vi.mock('@ae/core/db/workflow-stage-authority',()=>({assertWorkflowStageOwner:async(tx:unknown)=>{expect(tx).toBe(state.scope.tx);if(state.stale)throw new Error('stale');},registerWorkflowStageChild:vi.fn(),markWorkflowStageChildDispatch:vi.fn()}));
vi.mock('./cost-settlement',()=>({recordSettledCost:vi.fn()}));
vi.mock('@ae/core/adapters/index',()=>({createServiceAdapters:()=>({})}));
vi.mock('@ae/core/db/client',()=>({db:()=>{throw new Error('pooled_publication_forbidden');},schema:{}}));
vi.mock('@ae/core/storage/blob',()=>({readJobArtifactText:vi.fn()}));
import { recordProgress, saveFindings, saveRemediation, setJobState } from './job-store';
beforeEach(()=>{
 state.stale=false;state.failWrite=false;state.committed=[];state.pending=[];state.query.mockReset();
 const tx={query:state.query};
 state.query.mockImplementation(async(text:string)=>{state.pending.push(text);if(state.failWrite&&text.startsWith('INSERT'))throw new Error('write_failed');return {rows:text.startsWith('SELECT id')?[{id:'finding'}]:[]};});
 state.scope={owner:{jobId:'job',stageKey:'stage',token:'private',generation:1},tx,transaction:async(fn:any)=>{state.pending=[];try{const value=await fn(tx);state.committed.push(...state.pending);return value;}catch(e){state.pending=[];throw e;}}};
});
it('writes state/progress on the exact transaction used by owner validation with bound data',async()=>{
 await setJobState('job','running',{suiteBlobPath:'private/path'});await recordProgress('job','milestone','message');
 expect(state.query.mock.calls[0]).toEqual(['UPDATE jobs SET state=$2,updated_at=now(),suite_blob_path=$3 WHERE id=$1',['job','running','private/path']]);
 expect(state.committed).toHaveLength(2);
});
it('rejects stale owners before any publication SQL',async()=>{
 state.stale=true;await expect(recordProgress('job','m','message')).rejects.toThrow('stale');expect(state.query).not.toHaveBeenCalled();
});
it('rejects cross-job publication and unrecognized dynamic columns',async()=>{
 await expect(setJobState('other','running')).rejects.toThrow('job_mismatch');
 await expect(setJobState('job','running',{injected:'bad'} as any)).rejects.toThrow('invalid_job_column');expect(state.query).not.toHaveBeenCalled();
});
it('rolls back finding reads and writes together when publication fails',async()=>{
 state.failWrite=true;await expect(saveFindings('job',[{id:'finding'} as any])).rejects.toThrow('write_failed');expect(state.committed).toEqual([]);expect(state.pending).toEqual([]);
});
it('verifies remediation belongs to the scoped job and uses one owner transaction',async()=>{
 await saveRemediation('job','finding',{summary:'fix'} as any);
 expect(state.query.mock.calls[0]).toEqual(['SELECT id FROM findings WHERE id=$1 AND job_id=$2',['finding','job']]);expect(state.committed).toHaveLength(2);
});
