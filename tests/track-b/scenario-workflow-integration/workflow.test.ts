import {beforeEach,describe,it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>({prepare:vi.fn(),scenario:vi.fn(),finalize:vi.fn(),fail:vi.fn(),teardown:vi.fn()}));
vi.mock('workflow',()=>({FatalError:class FatalError extends Error {name='FatalError';}}));
vi.mock('@/workflows/steps/sandbox',()=>({prepareSandboxRunStep:calls.prepare,runSandboxScenarioStep:calls.scenario,finalizeSandboxRunStep:calls.finalize,failSandboxRunStep:calls.fail,teardownSandboxRunStep:calls.teardown,failSandboxSuiteStep:vi.fn(),generateSandboxSuiteStep:vi.fn(),gateSandboxSuiteStep:vi.fn()}));
import {sandboxRunWorkflow} from '@/workflows/sandbox';
beforeEach(()=>{Object.values(calls).forEach(x=>x.mockReset());calls.prepare.mockResolvedValue({worldId:'world',scenarioIds:['S1','S2']});calls.scenario.mockResolvedValue({status:'ok',passed:1,trials:1});calls.finalize.mockResolvedValue({passAt1:1,passHatK:1});});
describe('actual owner Workflow orchestration',()=>{
 it('unresolved does not finalize, fail, dispatch another scenario, or tear down an active world',async()=>{
  calls.scenario.mockResolvedValue({status:'unresolved',reason:'pending'});
  expect(await sandboxRunWorkflow('run')).toEqual({runId:'run',status:'unresolved'});
  expect(calls.scenario).toHaveBeenCalledTimes(1);expect(calls.finalize).not.toHaveBeenCalled();expect(calls.fail).not.toHaveBeenCalled();expect(calls.teardown).not.toHaveBeenCalled();
 });
 it('a lost step response retains the world rather than failing or deleting it',async()=>{
  calls.scenario.mockRejectedValue(new Error('worker response lost'));
  expect(await sandboxRunWorkflow('run')).toEqual({runId:'run',status:'unresolved'});expect(calls.finalize).not.toHaveBeenCalled();expect(calls.fail).not.toHaveBeenCalled();expect(calls.teardown).not.toHaveBeenCalled();
 });
 it('success still finalizes and cleans up',async()=>{
  expect(await sandboxRunWorkflow('run')).toEqual({runId:'run',status:'complete'});expect(calls.scenario).toHaveBeenCalledTimes(2);expect(calls.finalize).toHaveBeenCalledWith('run',false);expect(calls.teardown).toHaveBeenCalledWith('run','world');
 });
 it('known budget exhaustion preserves its ordinary terminal cleanup',async()=>{
  calls.scenario.mockResolvedValue({status:'budget_exhausted',passed:0,trials:0});expect(await sandboxRunWorkflow('run')).toEqual({runId:'run',status:'complete'});expect(calls.finalize).toHaveBeenCalledWith('run',true);expect(calls.teardown).toHaveBeenCalledTimes(1);
 });
});
