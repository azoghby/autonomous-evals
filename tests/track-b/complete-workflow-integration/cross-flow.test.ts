import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ api:null as any,persist:vi.fn(),artifact:vi.fn(),progress:vi.fn() }));
vi.mock('@/server/rich-services',()=>({createRichWorkflowServices:async()=>state.api,workflowSql:()=>({query:async()=>({rows:[]})})}));
vi.mock('@/server/rich-artifacts',()=>({persistRichArtifact:(...a:unknown[])=>state.artifact(...a)}));
vi.mock('@/server/job-store',()=>({getJob:async()=>({workflowRunId:'workflow',state:'planning',isMock:false,package:'text_eval'}),setJobState:vi.fn(),recordProgress:(...a:unknown[])=>state.progress(...a)}));
vi.mock('@step-evaluate',()=>({persistReportStep:(...a:unknown[])=>state.persist(...a),createBranchStep:vi.fn()}));
vi.mock('@step-common',()=>({withBudget:async(_j:string,_a:string,run:any)=>({status:'ok',data:await run({jobId:'job',environment:'test'})})}));
import { richEvaluationStep } from '@rich-step';
beforeEach(()=>{
 vi.clearAllMocks();process.env.REDTEAM_PACK='off';
 const suite={digest:'a'.repeat(64),scenarios:Array.from({length:12},(_,i)=>({id:`s${i}`}))};
 state.api={job:{jobId:'job',customerId:'tenant',environment:'test'},intake:{package:'text_eval',endpoint:{systemPrompt:'prompt'}},knownSecrets:[],
  inventory:{touch:vi.fn(),phase:async(_a:unknown,run:any)=>run(),acquisition:vi.fn()},advanceData:vi.fn(async()=>null),approvedData:vi.fn(),
  text:{getSuite:vi.fn(async()=>suite),designSuite:vi.fn(async()=>({status:'completed',suite})),runSuite:vi.fn(async()=>({runId:'run:job:baseline',executions:[{checks:[{status:'not_assessed'}]}]})),investigate:vi.fn(async()=>({investigatorStatus:'completed',findings:[],limitations:[]})),reportInput:vi.fn(async()=>({richFindings:[],limitations:['Unassessed factual correctness']}))},
  bindTextBaseline:vi.fn(),renderReport:vi.fn(async()=>({markdown:'Unassessed',findings:[]})),dispose:vi.fn()};
});
it('approved suite reaches remediation with exact baseline and complete private evidence, without redesign',async()=>{
 const suite=await state.api.text.getSuite();state.api.text.getSuite.mockClear();
 const provenance={taskId:'approved-task',sourceIds:['private-source'],referenceDigest:'b'.repeat(64),privateApproval:{receipt:'approved-receipt'}};
 const run={runId:'run:job:baseline',executions:[{scenarioId:'s0',checks:[{checkId:'s0.objective',kind:'objective',status:'fail'}]}]};
 const finding={id:'confirmed-objective',label:'confirmed',evidence:[{kind:'check',checkId:'s0.objective'}]};
 const remediation={remediation:{verification:{status:'not_verified'}},reason:'Isolation approval missing.',scope:'Frozen12 only.',applied:[],executions:[]};
 state.api.advanceData.mockResolvedValue({status:'ready',frozen:{suite,provenance}});
 state.api.approvedData.mockResolvedValue({suite,provenance});
 state.api.text.runSuite.mockResolvedValue(run);
 state.api.text.reportInput.mockResolvedValue({richFindings:[finding],limitations:['Factual checks remain unassessed.']});
 state.api.remediation={proposeAndVerifyFixDetailed:vi.fn(async()=>remediation)};
 expect(await richEvaluationStep('job','workflow')).toBe('complete');
 expect(state.api.text.designSuite).not.toHaveBeenCalled();
 expect(state.api.bindTextBaseline).toHaveBeenCalledWith(suite.digest,run.runId);
 expect(state.api.remediation.proposeAndVerifyFixDetailed).toHaveBeenCalledWith({jobId:'job',environment:'test'},{findingId:finding.id});
 const evidence=state.artifact.mock.calls[0][3];
 expect(evidence).toMatchObject({format:'rich_text_remediation.v1',suite,run,dataProvenance:provenance,remediation});
 expect(evidence.limitations).toEqual(state.api.renderReport.mock.calls[0][1].limitations);
 expect(evidence.limitations).toHaveLength(4);
 expect(evidence.limitations.join(' ')).toContain('HTTP provider monetary amounts remain unknown');
 expect(evidence.limitations.join(' ')).toContain('Appended packs remain separately gated');
 expect(evidence.limitations.join(' ')).toContain('Isolation approval missing');
 expect(state.api.dispose).toHaveBeenCalledOnce();
});
