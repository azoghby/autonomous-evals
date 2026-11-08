import { beforeEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({scope:undefined as undefined|{owner:{jobId:string;stageKey:string;generation:number;token:string}},current:vi.fn(),owner:vi.fn()}));
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>mocks.scope,assertWorkflowStageCurrent:mocks.current}));
vi.mock('@ae/core/db/workflow-stage-authority',()=>({assertWorkflowStageOwner:mocks.owner}));
import { assertExpertTextStage } from './expert-text-runtime';
beforeEach(()=>{vi.clearAllMocks();mocks.scope={owner:{jobId:'job',stageKey:'expert',generation:2,token:'owner'}};});
it('checks artifact ownership using the exact writer transaction',async()=>{
 const tx={query:vi.fn()};await assertExpertTextStage('job',tx);expect(mocks.owner).toHaveBeenCalledWith(tx,mocks.scope!.owner);expect(mocks.current).not.toHaveBeenCalled();
});
it('plain runtime checks use a separate current check and reject cross-job scope',async()=>{
 await assertExpertTextStage('job');expect(mocks.current).toHaveBeenCalledTimes(1);expect(mocks.owner).not.toHaveBeenCalled();await expect(assertExpertTextStage('other',{query:vi.fn()})).rejects.toThrow('authority_unavailable');expect(mocks.owner).not.toHaveBeenCalled();
});
it('stale transaction fence aborts authorization and unscoped callers retain existing behavior',async()=>{
 mocks.owner.mockRejectedValueOnce(Error('stale'));await expect(assertExpertTextStage('job',{query:vi.fn()})).rejects.toThrow('stale');mocks.scope=undefined;await assertExpertTextStage('job',{query:vi.fn()});expect(mocks.owner).toHaveBeenCalledTimes(1);
});
