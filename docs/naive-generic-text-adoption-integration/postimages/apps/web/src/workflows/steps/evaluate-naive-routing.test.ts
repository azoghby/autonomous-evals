import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const p=vi.hoisted(()=>({services:{designSuite:vi.fn(),runSuite:vi.fn(),createJobBranch:vi.fn()},intake:{package:'text_eval',endpoint:{url:'https://example.com',model:'m',apiKey:'secret'}},append:vi.fn(),coverage:vi.fn(),assert:vi.fn(),publish:vi.fn(),report:vi.fn(),put:vi.fn(),claim:vi.fn(),complete:vi.fn(),notify:vi.fn(),released:false}));
vi.mock('@/server/naive-text-publication',()=>({createNaiveTextPublication:async()=>({reportContext:p.coverage,assertCurrent:p.assert,atomicPublish:p.publish}),claimNaiveTextDeliveryNotification:p.claim,completeNaiveTextDeliveryNotification:p.complete,readNaiveTextDeliveryReceipt:vi.fn()}));
vi.mock('@ae/core/integration/eval-services',async original=>({...await original<typeof import('@ae/core/integration/eval-services')>(),evalServices:{renderReport:p.report}}));
vi.mock('@/workflows/steps/notify',()=>({notifyCustomerStep:p.notify}));
vi.mock('@/server/services',()=>({getEvalServices:async()=>p.services}));
vi.mock('@/workflows/steps/common',()=>({loadIntake:async()=>p.intake,requireJob:async()=>({state:'planning'}),withBudget:async(_j:unknown,_a:unknown,fn:(ctx:unknown)=>unknown)=>{const data=await fn({recordProgress:async()=>{}});p.released=true;return {status:'ok',data};}}));
vi.mock('@ae/core/redteam/index',()=>({appendRedTeamToSuite:p.append}));
vi.mock('@ae/core/storage/blob',()=>({putJobArtifact:p.put}));
vi.mock('@/server/job-store',()=>({makeServiceContext:async()=>({jobId:'job',environment:'test',budgetMicroUsd:0}),recordProgress:vi.fn(),setJobState:vi.fn(),saveFindings:vi.fn(),saveRemediation:vi.fn(),findingRowIdByKey:vi.fn()}));
vi.mock('@/server/branch-connection',()=>({resolveBranchConnection:vi.fn()}));
import {createBranchStep,designSuiteStep,runSuiteStep,genericTextReportStep,genericTextNotifyStep} from '@/workflows/steps/evaluate';
afterEach(()=>vi.unstubAllEnvs());
describe('actual selected generic evaluation steps',()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('EVAL_SERVICES','real');vi.stubEnv('EVAL_NAIVE_METHODS','designSuite,runSuite,investigate');vi.stubEnv('REDTEAM_PACK','1');p.released=false;p.put.mockResolvedValue('private-artifact');p.coverage.mockResolvedValue({assessed:12,summary:'12 assessed; remediation not performed'});p.assert.mockResolvedValue(undefined);p.publish.mockImplementation(async()=>{expect(p.released).toBe(true);return {deliveredAtIso:'2026-11-08T00:00:00.000Z'};});p.report.mockResolvedValue({jobId:'job',summary:'summary',markdown:'report',html:'<p>report</p>',findings:[]});p.claim.mockResolvedValue({status:'claimed',token:'canonical-token'});p.complete.mockResolvedValue(undefined);});
 it('text execution creates no simulator branch',async()=>{expect(await createBranchStep('job')).toEqual({});expect(p.services.createJobBranch).not.toHaveBeenCalled();});
 it('does not append red-team cases after design admission',async()=>{const suite={scenarios:[],versionLabel:'admitted'};p.services.designSuite.mockResolvedValue(suite);expect((await designSuiteStep('job'))).toMatchObject({data:suite});expect(p.append).not.toHaveBeenCalled();});
 it('retains legacy post-design augmentation and public version projection',async()=>{vi.stubEnv('EVAL_NAIVE_METHODS','');const suite={scenarios:[],jobId:'job',versionLabel:'admitted',frozenAt:'2026-01-01'};p.services.designSuite.mockResolvedValue(suite);p.append.mockReturnValue(suite);await designSuiteStep('job');expect(p.append).toHaveBeenCalledWith(suite,p.intake);p.services.runSuite.mockResolvedValue({results:[]});await runSuiteStep('job',suite,'endpoint','A');expect(p.services.runSuite.mock.calls[0][1]).toMatchObject({versionLabel:'A'});});
 it('preserves exact suite identity across public version labels',async()=>{const suite={scenarios:[],jobId:'job',versionLabel:'admitted',frozenAt:'2026-01-01'};p.services.runSuite.mockResolvedValue({results:[]});await runSuiteStep('job',suite,'endpoint','default');expect(p.services.runSuite.mock.calls[0][1]).toBe(suite);});
 it('holds entirely unassessed results before paid rendering, blobs, or publication',async()=>{
  p.coverage.mockResolvedValue({assessed:0,summary:'no assessment'});expect(await genericTextReportStep('job',[],{} as never)).toEqual({status:'ok',data:{assessed:false}});expect(p.report).not.toHaveBeenCalled();expect(p.put).not.toHaveBeenCalled();expect(p.publish).not.toHaveBeenCalled();
 });
 it('publishes assessed coverage atomically after releasing the paid reservation',async()=>{
  expect(await genericTextReportStep('job',[],{} as never)).toMatchObject({status:'ok',data:{assessed:true,deliveredAtIso:'2026-11-08T00:00:00.000Z'}});expect(p.report.mock.calls[0][1].remediations).toEqual([]);expect(p.publish.mock.calls[0][0].summary).toContain('12 assessed');expect(p.put).toHaveBeenCalledTimes(4);expect(genericTextReportStep.maxRetries).toBe(0);
 });
 it('refuses changed current authority before uploading or publishing',async()=>{
  p.assert.mockRejectedValueOnce(new Error('authority_revoked'));await expect(genericTextReportStep('job',[],{} as never)).rejects.toThrow('authority_revoked');expect(p.put).not.toHaveBeenCalled();expect(p.publish).not.toHaveBeenCalled();
 });
 it('does not redispatch an ambiguous or completed notification claim',async()=>{
  p.claim.mockResolvedValue({status:'pending'});expect(await genericTextNotifyStep('job')).toBe(false);expect(p.notify).not.toHaveBeenCalled();p.claim.mockResolvedValue({status:'completed'});expect(await genericTextNotifyStep('job')).toBe(true);expect(p.notify).not.toHaveBeenCalled();
 });
 it('completes only its own notification attempt token after the existing sender returns',async()=>{
  expect(await genericTextNotifyStep('job')).toBe(true);expect(p.notify).toHaveBeenCalledOnce();expect(p.complete.mock.calls[0][1]).toBe('canonical-token');expect(genericTextNotifyStep.maxRetries).toBe(0);
 });

});
