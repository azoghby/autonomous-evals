import { expect, it, vi } from 'vitest';
const execute=vi.hoisted(()=>vi.fn());
vi.mock('@/server/workflow-stage-runtime',()=>({executeWorkflowStage:execute}));
vi.mock('@/server/job-store',()=>({getJob:async()=>({customerId:'owner',environment:'test'}),makeServiceContext:async()=>({budgetMicroUsd:999}),getJobWithDecryptedCredentials:vi.fn()}));
vi.mock('workflow',()=>({FatalError:class extends Error{}}));
import { withBudget } from './common';
it('sets the exact admitted envelope and passes explicit logical stage to exclusive executor',async()=>{
 const stage={key:'qualification:2',input:{revision:2}};
 execute.mockImplementation(async(_input,run)=>({ok:true,data:await run(123)}));
 const callback=vi.fn(async ctx=>ctx.budgetMicroUsd);
 expect(await withBudget('job','commercial',stage,callback)).toEqual({status:'ok',data:123});
 expect(execute.mock.calls[0][0]).toMatchObject({jobId:'job',ownerId:'owner',environment:'test',stage});
});
it('does not run a callback after shared admission refusal',async()=>{
 execute.mockResolvedValue({ok:false,remainingMicroUsd:2});const callback=vi.fn();
 expect(await withBudget('job','commercial',{key:'q',input:{}},callback)).toMatchObject({status:'budget_exceeded'});expect(callback).not.toHaveBeenCalled();
});
