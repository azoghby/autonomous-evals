import { beforeEach, expect, it, vi } from 'vitest';
import { TrackBBlockedError, TrackBPendingError } from '@ae/core/evals/service-adapter';
const state = vi.hoisted(() => ({ api: null as any, progress: vi.fn(), persist: vi.fn(), artifact: vi.fn(), phases: [] as string[], tasks: [] as {task_id:string}[], pack:null as any, executePack:vi.fn() }));
vi.mock('@/server/workflow-pack-projection',()=>({attachWorkflowPackEvidence:(base:any,pack:any)=>({...base,appendedPack:pack}),containsWorkflowPackArtifactSecret:()=>false,projectWorkflowPack:(pack:any)=>({appendedPack:{cases:pack.pack.results}})}));
vi.mock('@/server/workflow-packs',()=>({workflowPackSelection:async()=>{if(!state.pack)throw new Error('review_required');return {authorizationId:'approved'};},executeWorkflowPack:async(input:unknown)=>{state.executePack(input);return state.pack;}}));
vi.mock('@/server/rich-services', () => ({ createRichWorkflowServices: async () => { if (state.api instanceof Error) throw state.api; return state.api; }, workflowSql: () => ({query: async () => ({rows:state.tasks})}) }));
vi.mock('@/server/rich-artifacts', () => ({ persistRichArtifact: (...a:unknown[]) => state.artifact(...a) }));
vi.mock('@/server/job-store', () => ({ getJob: async () => ({workflowRunId:'workflow',state:'planning',isMock:false}), recordProgress: (...a:unknown[]) => state.progress(...a), setJobState: async (_id:string,phase:string) => {state.phases.push(phase);} }));
vi.mock('@step-evaluate', () => ({ persistReportStep: (...a:unknown[]) => state.persist(...a) }));
vi.mock('@step-common', () => ({ withBudget: async (_j:string,_a:string,run:any) => ({status:'ok',data:await run({jobId:'job',environment:'test'})}) }));
import { richEvaluationStep } from '@rich-step';
beforeEach(() => {
 vi.clearAllMocks(); state.phases=[]; state.tasks=[]; state.pack=null; process.env.REDTEAM_PACK='off';
 const suite={digest:'a'.repeat(64),scenarios:Array.from({length:12},(_,i)=>({id:`s${i}`}))};
 const investigation={investigatorStatus:'completed',findings:[],limitations:[]};
 state.api={job:{jobId:'job',customerId:'tenant',environment:'test'},intake:{package:'text_eval',endpoint:{systemPrompt:'prompt'}},knownSecrets:[],
 inventory:{touch:vi.fn(),phase:async (_a:unknown,run:any)=>run(),acquisition:vi.fn()},
 text:{designSuite:vi.fn(async()=>({status:'completed',suite})),runSuite:vi.fn(async()=>({runId:'run:job:baseline',executions:[{checks:[{status:'not_assessed'}]}]})),investigate:vi.fn(async()=>investigation),reportInput:vi.fn(async()=>({richFindings:[],limitations:['Factual correctness not assessed.']}))},
 bindTextBaseline:vi.fn(),renderReport:vi.fn(async()=>({markdown:'Unassessed factual correctness',findings:[]})),dispose:vi.fn()};
});
it('preserves unassessed evidence and report limitations; no legacy boolean projection',async()=>{
 expect(await richEvaluationStep('job','workflow')).toBe('complete');
 expect(state.artifact.mock.calls[0][3].run.executions[0].checks[0].status).toBe('not_assessed');
 expect(state.api.renderReport.mock.calls[0][1].limitations).toContain('Factual correctness not assessed.');
 expect(state.persist).toHaveBeenCalledOnce(); expect(state.api.dispose).toHaveBeenCalledOnce();
});
it('restarts with identical suite/run identity',async()=>{
 await richEvaluationStep('job','workflow'); await richEvaluationStep('job','workflow');
 const calls=state.api.text.runSuite.mock.calls;
 expect(calls[0][1]).toEqual(calls[1][1]); expect(calls[0][1].runId).toBe('run:job:baseline');
});
it('pending work remains pending without report',async()=>{
 state.api.text.runSuite.mockRejectedValueOnce(new TrackBPendingError(5000,'pending'));
 expect(await richEvaluationStep('job','workflow')).toBe('pending'); expect(state.persist).not.toHaveBeenCalled();expect(state.api.dispose).toHaveBeenCalled();
});
it('budget pauses persist explicit state',async()=>{
 state.api.text.runSuite.mockRejectedValueOnce(new TrackBBlockedError('paused_budget','paused'));
 expect(await richEvaluationStep('job','workflow')).toBe('paused_budget');expect(state.phases).toContain('paused_budget');expect(state.persist).not.toHaveBeenCalled();
});
it('canonical authority rejection cannot publish a report',async()=>{
 state.api=new TrackBBlockedError('rejected_input','unauthorized');expect(await richEvaluationStep('job','foreign')).toBe('needs_operator');expect(state.persist).not.toHaveBeenCalled();
});
it('missing approval pauses after retained design and before target execution',async()=>{
 process.env.REDTEAM_PACK='on';expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');expect(state.api.text.designSuite).toHaveBeenCalledOnce();expect(state.api.text.runSuite).not.toHaveBeenCalled();
});
it('missing reviewed data remains a durable blocker',async()=>{
 state.tasks=[{task_id:'data'}];expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');expect(state.api.inventory.acquisition).toHaveBeenCalledWith(['data']);expect(state.api.text.designSuite).not.toHaveBeenCalled();expect(state.persist).not.toHaveBeenCalled();
});
it('ambiguous work requires operator reconciliation without redispatch',async()=>{
 state.api.text.runSuite.mockRejectedValueOnce(new TrackBBlockedError('needs_operator','ambiguous'));expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');expect(state.persist).not.toHaveBeenCalled();
});

it('passes the independent base suite/run to the pack adapter and retains complete separate evidence',async()=>{
 process.env.REDTEAM_PACK='on';state.pack={manifest:{inventory:[{id:'rt_case'}]},base:{status:'pass'},pack:{status:'fail',expectedIds:['rt_case'],results:[{id:'rt_case',status:'fail'}]}};
 expect(await richEvaluationStep('job','workflow')).toBe('complete');
 expect(state.executePack.mock.calls[0][0].baseSuite.scenarios).toHaveLength(12);
 expect(state.executePack.mock.calls[0][0].baseRun.runId).toBe('run:job:baseline');
 expect(state.artifact.mock.calls[0][3].appendedPack).toEqual(state.pack);
 expect(state.api.renderReport.mock.calls[0][1].limitations.join(' ')).toContain('Appended pack status: fail');
});
it('retains unknown/quarantined pack evidence and draft report but blocks delivery',async()=>{
 process.env.REDTEAM_PACK='on';state.pack={pack:{status:'quarantined',results:[{id:'rt_case',status:'quarantined'}]}};
 expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');
 expect(state.artifact.mock.calls[0][3].appendedPack).toEqual(state.pack);expect(state.persist).toHaveBeenCalledOnce();
 expect(state.artifact.mock.invocationCallOrder[0]).toBeLessThan(state.persist.mock.invocationCallOrder[0]);
});

it('a failing assessed case cannot hide simultaneous quarantined coverage',async()=>{
 process.env.REDTEAM_PACK='on';state.pack={pack:{status:'fail',results:[{id:'rt_failed',status:'fail'},{id:'rt_unsupported',status:'quarantined'}]}};
 expect(await richEvaluationStep('job','workflow')).toBe('needs_operator');
 expect(state.artifact.mock.calls[0][3].appendedPack.pack.results).toHaveLength(2);
 expect(state.persist).toHaveBeenCalledOnce();
});
