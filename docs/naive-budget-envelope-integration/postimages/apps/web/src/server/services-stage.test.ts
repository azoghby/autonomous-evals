import { expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn(()=>({qualify:vi.fn(),auditTrace:vi.fn(),renderReport:vi.fn()})),sessions:vi.fn(),runner:vi.fn(),ledger:vi.fn()}));
vi.mock('./workflow-stage-budget',()=>({createWorkflowStageBudgetLedger:mocks.ledger}));
vi.mock('./workflow-stage-children',()=>({fenceWorkflowStageSessions:mocks.sessions,fenceWorkflowStageRunner:mocks.runner}));
vi.mock('@ae/core/integration/eval-services',async original=>({...await original<typeof import('@ae/core/integration/eval-services')>(),createRealEvalServices:mocks.create}));
it('mounts budget admission and both child decorators on app-owned real composition including explicit expert real services',async()=>{
 vi.resetModules();const {stageRealEvalServices,getEvalServices}=await import('./services');
 expect(mocks.create).toHaveBeenCalledWith({createBudgetLedger:mocks.ledger,decorateNaiveSessions:mocks.sessions,decorateAgentRunner:mocks.runner});expect(stageRealEvalServices).toHaveProperty('renderReport');
 vi.stubEnv('EVAL_SERVICES','real');const services=await getEvalServices();await services.qualify({} as never,{} as never,[]);expect(stageRealEvalServices.qualify).toHaveBeenCalled();vi.unstubAllEnvs();
});
