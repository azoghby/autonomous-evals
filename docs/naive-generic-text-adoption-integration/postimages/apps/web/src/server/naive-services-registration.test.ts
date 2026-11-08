import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ServiceContext} from '@ae/core/contracts/services';
const ports=vi.hoisted(()=>({createBuilder:vi.fn(),builder:vi.fn(),design:vi.fn()}));
vi.mock('./naive-text-methods',()=>({createNaiveTextMethodBuilder:ports.createBuilder}));
import {getEvalServices} from './services';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('app factory default owner registration',()=>{
 it('loads actual owner builder lazily only on selected calls and caches composition seam',async()=>{
  vi.stubEnv('EVAL_SERVICES','real');vi.stubEnv('EVAL_NAIVE_METHODS','designSuite');
  ports.createBuilder.mockReturnValue(ports.builder);ports.builder.mockResolvedValue({designSuite:ports.design});ports.design.mockResolvedValue({id:'retained'});
  const services=await getEvalServices();expect(ports.createBuilder).not.toHaveBeenCalled();
  const ctx={jobId:'job',environment:'test',budgetMicroUsd:100} as ServiceContext;
  await services.designSuite(ctx,{} as never);await services.designSuite(ctx,{} as never);
  expect(ports.createBuilder).toHaveBeenCalledOnce();expect(ports.builder).toHaveBeenCalledTimes(2);expect(ports.builder).toHaveBeenCalledWith('designSuite',ctx);
 });
});
