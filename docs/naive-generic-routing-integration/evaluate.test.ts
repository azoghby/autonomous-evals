import {beforeEach,describe,expect,it,vi} from 'vitest';
const p=vi.hoisted(()=>({services:{designSuite:vi.fn(),runSuite:vi.fn(),createJobBranch:vi.fn()},intake:{package:'text_eval',endpoint:{url:'https://example.com',model:'m',apiKey:'secret'}},append:vi.fn()}));
vi.mock('@/server/services',()=>({getEvalServices:async()=>p.services}));
vi.mock('@/workflows/steps/common',()=>({loadIntake:async()=>p.intake,requireJob:async()=>({state:'planning'}),withBudget:async(_j:unknown,_a:unknown,fn:(ctx:unknown)=>unknown)=>({status:'ok',data:await fn({recordProgress:async()=>{}})})}));
vi.mock('@ae/core/redteam/index',()=>({appendRedTeamToSuite:p.append}));
vi.mock('@ae/core/storage/blob',()=>({putJobArtifact:async()=> 'artifact'}));
vi.mock('@/server/job-store',()=>({recordProgress:vi.fn(),setJobState:vi.fn(),saveFindings:vi.fn(),saveRemediation:vi.fn(),findingRowIdByKey:vi.fn()}));
vi.mock('@/server/branch-connection',()=>({resolveBranchConnection:vi.fn()}));
import {createBranchStep,designSuiteStep,runSuiteStep} from '@/workflows/steps/evaluate';
describe('actual selected generic evaluation steps',()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('EVAL_SERVICES','real');vi.stubEnv('EVAL_NAIVE_METHODS','designSuite,runSuite,investigate');vi.stubEnv('REDTEAM_PACK','1');});
 it('text execution creates no simulator branch',async()=>{expect(await createBranchStep('job')).toEqual({});expect(p.services.createJobBranch).not.toHaveBeenCalled();});
 it('does not append red-team cases after design admission',async()=>{const suite={scenarios:[],versionLabel:'admitted'};p.services.designSuite.mockResolvedValue(suite);expect((await designSuiteStep('job'))).toMatchObject({data:suite});expect(p.append).not.toHaveBeenCalled();});
 it('retains legacy post-design augmentation and public version projection',async()=>{vi.stubEnv('EVAL_NAIVE_METHODS','');const suite={scenarios:[],jobId:'job',versionLabel:'admitted',frozenAt:'2026-01-01'};p.services.designSuite.mockResolvedValue(suite);p.append.mockReturnValue(suite);await designSuiteStep('job');expect(p.append).toHaveBeenCalledWith(suite,p.intake);p.services.runSuite.mockResolvedValue({results:[]});await runSuiteStep('job',suite,'endpoint','A');expect(p.services.runSuite.mock.calls[0][1]).toMatchObject({versionLabel:'A'});});
 it('preserves exact suite identity across public version labels',async()=>{const suite={scenarios:[],jobId:'job',versionLabel:'admitted',frozenAt:'2026-01-01'};p.services.runSuite.mockResolvedValue({results:[]});await runSuiteStep('job',suite,'endpoint','default');expect(p.services.runSuite.mock.calls[0][1]).toBe(suite);});
});
