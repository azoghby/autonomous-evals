import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ServiceContext} from '@ae/core/contracts/services';
const ports=vi.hoisted(()=>({createBuilder:vi.fn(),builder:vi.fn(),design:vi.fn(),resolve:vi.fn()}));
vi.mock('./naive-text-methods',()=>({createNaiveTextMethodBuilder:ports.createBuilder}));
vi.mock('./naive-text-execution-runtime',()=>({resolveJobNaiveExecution:ports.resolve}));
import {TextFactualGapError} from '@ae/core/evals/text/factual-gap';
import {getEvalServices} from './services';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('app factory default owner registration',()=>{
 it('loads actual owner builder lazily only on selected calls and resolves durable policy on every selected call',async()=>{
  vi.stubEnv('EVAL_SERVICES','real');vi.stubEnv('EVAL_NAIVE_METHODS','designSuite');
  ports.resolve.mockResolvedValue({generic:true,profile:{policyId:'generic-text-factual-gap-v1'}});
  ports.createBuilder.mockReturnValue(ports.builder);ports.builder.mockResolvedValue({designSuite:ports.design});ports.design.mockResolvedValue({id:'retained'});
  const services=await getEvalServices();expect(ports.createBuilder).not.toHaveBeenCalled();
  const ctx={jobId:'job',environment:'test',budgetMicroUsd:100} as ServiceContext;
  await services.designSuite(ctx,{} as never);await services.designSuite(ctx,{} as never);
  expect(ports.createBuilder).toHaveBeenCalledTimes(2);expect(ports.resolve).toHaveBeenCalledTimes(2);expect(ports.builder).toHaveBeenCalledTimes(2);expect(ports.builder).toHaveBeenCalledWith('designSuite',ctx);
 });
});

it('preserves a typed factual gap through both real service wrappers for private-step retention',async()=>{
 vi.stubEnv('EVAL_SERVICES','real');vi.stubEnv('EVAL_NAIVE_METHODS','designSuite,runSuite,investigate');
 const gap=Object.create(TextFactualGapError.prototype) as TextFactualGapError;
 const services=await getEvalServices(async()=>({designSuite:async()=>{throw gap;}}));
 await expect(services.designSuite({jobId:'job',environment:'test',budgetMicroUsd:100} as ServiceContext,{} as never)).rejects.toBe(gap);
});


it('retains owner-routed pending holds after Workflow translation without granting callback recovery',async()=>{
 const {isWorkflowStagePendingError,isWorkflowStageControlError}=await import('./services');
 const {FatalError}=await import('workflow');
 for(const message of ['NAIVE_ADMISSION_PENDING: review','NAIVE_OPERATION_PENDING: running']){
  const error=new FatalError(message);
  expect(isWorkflowStagePendingError(error)).toBe(true);
  expect(isWorkflowStageControlError(error)).toBe(true);
 }
 expect(isWorkflowStagePendingError(new FatalError('NAIVE_RECONCILIATION_REQUIRED'))).toBe(false);
});
