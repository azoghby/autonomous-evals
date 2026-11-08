import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({resolve:vi.fn(),stage:vi.fn(),build:vi.fn(),run:vi.fn(),expert:vi.fn()}));
vi.mock('./naive-text-execution-runtime',()=>({resolveJobNaiveExecution:mocks.resolve}));
vi.mock('./naive-run-recovery',()=>({naiveRunRecoveryStage:mocks.stage}));
vi.mock('./naive-text-methods',()=>({createNaiveTextMethodBuilder:()=>mocks.build}));
vi.mock('@ae/core/integration/eval-services',async original=>({...await original<typeof import('@ae/core/integration/eval-services')>(),createRealEvalServices:()=>({runSuite:mocks.expert})}));
afterEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();});
const profile={policyId:'generic-text-v1',designId:'generic-text-v1',versionLabel:'generic-text-v1',admissionPolicyId:'automated-text-design-v1'};
const ctx={jobId:'job',environment:'test',budgetMicroUsd:100,recordCost:async()=>{},recordProgress:async()=>{}} as const;
const suite={versionLabel:'generic-text-v1',scenarios:[]} as never,target={url:'https://example.test',model:'fixture',systemPrompt:''};
function selected(){vi.stubEnv('EVAL_SERVICES','real');mocks.resolve.mockResolvedValue({generic:true,identity:{jobId:'job',customerId:'customer',environment:'test'},profile,sql:{}});mocks.stage.mockResolvedValue({key:'suite-run:endpoint:default',recovery:'naive-text-run-v1'});mocks.build.mockResolvedValue({runSuite:mocks.run});}
it('mounts the generic builder only after stage admission and preserves raw pending without expert fallback',async()=>{
 selected();const {recoverableGenericTextRunStage}=await import('./services');
 const {TrackBPendingError}=await import('@ae/core/evals/service-adapter');
 const mounted=await recoverableGenericTextRunStage('job',suite,target,'endpoint','default');
 expect(mocks.build).not.toHaveBeenCalled();expect(mocks.stage).toHaveBeenCalledWith('job',suite,target,'endpoint','default',undefined,expect.objectContaining({generic:true}));
 const error=new TrackBPendingError(5000,'Retained judge is pending');mocks.run.mockRejectedValue(error);
 await expect(mounted.services.runSuite(ctx,suite,target)).rejects.toBe(error);
 expect(mocks.build).toHaveBeenCalledWith('runSuite',ctx);expect(mocks.run).toHaveBeenCalledWith(ctx,suite,target);expect(mocks.expert).not.toHaveBeenCalled();
});
it('propagates generic method failure without selecting expert fallback',async()=>{
 selected();const {recoverableGenericTextRunStage}=await import('./services');
 const error=new Error('generic unavailable');mocks.run.mockRejectedValue(error);
 const mounted=await recoverableGenericTextRunStage('job',suite,target,'endpoint','default');
 await expect(mounted.services.runSuite(ctx,suite,target)).rejects.toBe(error);expect(mocks.expert).not.toHaveBeenCalled();
});
it('refuses generic recovery for unselected calls and leaves the expert service direct',async()=>{
 mocks.resolve.mockResolvedValue({generic:false});const {recoverableGenericTextRunStage,stageRealEvalServices}=await import('./services');
 await expect(recoverableGenericTextRunStage('job',suite,target,'endpoint','default')).rejects.toThrow('NAIVE_EXECUTION_SELECTION_HOLD');
 expect(mocks.stage).not.toHaveBeenCalled();expect(mocks.build).not.toHaveBeenCalled();
 mocks.expert.mockResolvedValue({expert:true});expect(await stageRealEvalServices.runSuite(ctx,suite,target)).toEqual({expert:true});expect(mocks.build).not.toHaveBeenCalled();
});
