import {beforeEach,expect,it,vi} from 'vitest';
const s=vi.hoisted(()=>({api:null as any,artifact:vi.fn(),persist:vi.fn(),selection:vi.fn(),authorize:vi.fn(),pack:vi.fn(),order:[] as string[]}));
vi.mock('@/server/rich-services',()=>({createRichWorkflowServices:async()=>s.api,workflowSql:()=>({query:async()=>({rows:[]})})}));
vi.mock('@/server/rich-artifacts',()=>({persistRichArtifact:(...a:unknown[])=>s.artifact(...a)}));
vi.mock('@/server/job-store',()=>({getJob:async()=>({workflowRunId:'workflow',state:'planning',isMock:false,package:'text_eval'}),setJobState:vi.fn(),recordProgress:vi.fn()}));
vi.mock('@/server/workflow-packs',()=>({workflowPackSelection:(...a:unknown[])=>s.selection(...a),authorizeWorkflowPack:(...a:unknown[])=>s.authorize(...a),executeWorkflowPack:(...a:unknown[])=>s.pack(...a)}));
vi.mock('@/server/workflow-pack-projection',()=>({attachWorkflowPackEvidence:(base:any,pack:any)=>({...base,appendedPack:pack}),containsWorkflowPackArtifactSecret:()=>false,projectWorkflowPack:(pack:any)=>({appendedPack:{cases:pack.pack.results}})}));
vi.mock('@step-evaluate',()=>({persistReportStep:(...a:unknown[])=>s.persist(...a),createBranchStep:vi.fn()}));
vi.mock('@step-common',()=>({withBudget:async(_j:string,_a:string,run:any)=>({status:'ok',data:await run({jobId:'job',environment:'test'})})}));
import {richEvaluationStep} from '@rich-step';
beforeEach(()=>{
 vi.clearAllMocks();s.order=[];process.env.REDTEAM_PACK='on';
 const suite={digest:'a'.repeat(64),scenarios:Array.from({length:12},(_,i)=>({id:`s${i}`}))};
 const provenance={taskId:'approved-task',sourceIds:['private-source'],referenceDigest:'b'.repeat(64),privateApproval:{receipt:'approved-receipt'}};
 const finding={id:'confirmed-objective',label:'confirmed',evidence:[{kind:'check',checkId:'s0.objective'}]};
 const run={runId:'run:job:baseline',executions:[{scenarioId:'s0',checks:[{checkId:'s0.objective',kind:'objective',status:'fail'}]}]};
 const remediation={remediation:{verification:{status:'not_verified'}},reason:'Isolation approval missing.',scope:'Frozen12 only.',applied:[],executions:[]};
 s.api={job:{jobId:'job',customerId:'tenant',environment:'test'},intake:{package:'text_eval',endpoint:{systemPrompt:'prompt'}},knownSecrets:[],inventory:{touch:vi.fn(),phase:async(_a:unknown,fn:any)=>fn(),acquisition:vi.fn()},
 advanceData:vi.fn(async()=>({status:'ready',frozen:{suite,provenance}})),approvedData:vi.fn(async()=>({suite,provenance})),
 text:{getSuite:vi.fn(async()=>suite),designSuite:vi.fn(),runSuite:vi.fn(async()=>{s.order.push('baseline');return run;}),investigate:vi.fn(async()=>({investigatorStatus:'completed',findings:[finding],limitations:[]})),reportInput:vi.fn(async()=>({richFindings:[finding],limitations:['Factual checks remain unassessed.']}))},
 bindTextBaseline:vi.fn(),remediation:{proposeAndVerifyFixDetailed:vi.fn(async()=>remediation)},resolvePackTarget:vi.fn(),renderReport:vi.fn(async()=>({markdown:'Retained limitations',findings:[]})),dispose:vi.fn()};
 s.selection.mockImplementation(async()=>{s.order.push('approval');return {authorizationId:'approved'};});
 s.authorize.mockImplementation(async()=>{s.order.push('authorized');return {authorizationId:'approved'};});
 s.pack.mockResolvedValue({manifest:{inventory:[{id:'rt_supported'}]},base:{status:'fail',expectedIds:suite.scenarios.map(x=>x.id)},pack:{status:'pass',expectedIds:['rt_supported'],results:[{id:'rt_supported',status:'pass'}]}});
});
it('composes approveddata, supported pack and separate base12 remediation without redesign or dropping private evidence',async()=>{
 expect(await richEvaluationStep('job','workflow')).toBe('complete');
 expect(s.api.text.designSuite).not.toHaveBeenCalled();expect(s.order.indexOf('approval')).toBeLessThan(s.order.indexOf('baseline'));expect(s.order.indexOf('authorized')).toBeLessThan(s.order.indexOf('baseline'));
 const packInput=s.pack.mock.calls[0][0];expect(packInput.baseSuite.scenarios).toHaveLength(12);expect(packInput.baseRun.runId).toBe('run:job:baseline');
 const evidence=s.artifact.mock.calls[0][3];expect(evidence).toMatchObject({format:'rich_text_remediation.v1',dataProvenance:{privateApproval:{receipt:'approved-receipt'}},remediation:{scope:'Frozen12 only.'},appendedPack:{pack:{status:'pass'}}});
 expect(evidence.suite.scenarios).toHaveLength(12);expect(evidence.appendedPack.base.expectedIds).toHaveLength(12);expect(evidence.appendedPack.pack.expectedIds).toEqual(['rt_supported']);
 expect(s.api.remediation.proposeAndVerifyFixDetailed).toHaveBeenCalledWith({jobId:'job',environment:'test'},{findingId:'confirmed-objective'});
 expect(evidence.limitations).toEqual(s.api.renderReport.mock.calls[0][1].limitations);expect(evidence.limitations.join(' ')).toContain('HTTP provider monetary amounts remain unknown');expect(evidence.limitations.join(' ')).toContain('Isolation approval missing');expect(s.api.dispose).toHaveBeenCalledOnce();
});
it('approveddata cannot bypass missing immutable pack approval before baseline dispatch',async()=>{
 s.selection.mockRejectedValue(new Error('review_required'));expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');expect(s.api.text.getSuite).toHaveBeenCalled();expect(s.api.text.designSuite).not.toHaveBeenCalled();expect(s.api.text.runSuite).not.toHaveBeenCalled();expect(s.persist).not.toHaveBeenCalled();
});
it.each(['waiting_for_data','waiting_for_review','cost_delivery_pending'])('retains %s as pending before approval or dispatch',async status=>{
 s.api.advanceData.mockResolvedValue({status});expect(await richEvaluationStep('job','workflow')).toBe('pending');expect(s.selection).not.toHaveBeenCalled();expect(s.api.text.runSuite).not.toHaveBeenCalled();expect(s.persist).not.toHaveBeenCalled();
});
it('retains reconciliation blockers before pack and remediation dispatch',async()=>{
 s.api.advanceData.mockResolvedValue({status:'needs_operator'});expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');expect(s.pack).not.toHaveBeenCalled();expect(s.api.remediation.proposeAndVerifyFixDetailed).not.toHaveBeenCalled();expect(s.persist).not.toHaveBeenCalled();
});
it('retains both failure and unassessed pack coverage with private provenance and draft report',async()=>{
 s.pack.mockResolvedValue({pack:{status:'fail',results:[{id:'rt_failed',status:'fail'},{id:'rt_unknown',status:'quarantined'}]}});
 expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');expect(s.persist).toHaveBeenCalledOnce();expect(s.artifact.mock.calls[0][3]).toMatchObject({dataProvenance:{taskId:'approved-task'},remediation:{scope:'Frozen12 only.'},appendedPack:{pack:{results:[{id:'rt_failed'},{id:'rt_unknown'}]}}});
});

it('fresh authorization revocation blocks baseline even with retained pack selection',async()=>{s.authorize.mockRejectedValue(new Error('revoked'));expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');expect(s.api.text.runSuite).not.toHaveBeenCalled();expect(s.pack).not.toHaveBeenCalled();});
