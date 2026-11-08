import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createPostgresDataOperationLedger} from '@ae/core/evals/data/postgres-operations';
import {createAuthenticatedDataReviewLedger} from '@ae/core/evals/data/review-ledger';
import {dataReviewRequestDigest} from '@ae/core/evals/data/orchestration';
import {enqueueReviewResume,reviewWakeReady} from '@/server/workflow-resumption';
const s=vi.hoisted(()=>({api:null as any,sql:null as any,job:null as any,artifact:vi.fn(),persist:vi.fn(),selection:vi.fn(),authorize:vi.fn(),pack:vi.fn(),order:[] as string[]}));
vi.mock('@/server/rich-services',()=>({createRichWorkflowServices:async()=>s.api,workflowSql:()=>s.sql}));
vi.mock('@/server/rich-artifacts',()=>({persistRichArtifact:(...a:unknown[])=>s.artifact(...a)}));
vi.mock('@/server/job-store',()=>({getJob:async()=>s.job,setJobState:vi.fn(),recordProgress:vi.fn()}));
vi.mock('@/server/workflow-packs',()=>({workflowPackSelection:(...a:unknown[])=>s.selection(...a),authorizeWorkflowPack:(...a:unknown[])=>s.authorize(...a),executeWorkflowPack:(...a:unknown[])=>s.pack(...a)}));
vi.mock('@/server/workflow-pack-projection',()=>({attachWorkflowPackEvidence:(base:any,pack:any)=>({...base,appendedPack:pack}),containsWorkflowPackArtifactSecret:()=>false,projectWorkflowPack:(pack:any)=>({appendedPack:{cases:pack.pack.results}})}));
vi.mock('@step-evaluate',()=>({persistReportStep:(...a:unknown[])=>s.persist(...a),createBranchStep:vi.fn()}));
vi.mock('@step-common',()=>({withBudget:async(_j:string,_a:string,run:any)=>({status:'ok',data:await run({jobId:s.job.id,environment:'test'})})}));
import {richEvaluationStep} from '@rich-step';
const scope={jobId:'a1b2c3d4-e5f6-4abc-8def-aabbccddeeff',tenantId:'b1c2d3e4-f5a6-4abc-8def-bbccddeeffaa',environment:'test' as const,workflowRunId:'workflow-original'};
let pg:PGlite;
beforeEach(async()=>{
 vi.clearAllMocks();s.order=[];process.env.REDTEAM_PACK='on';pg=new PGlite();
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,workflow_run_id text,package text,is_mock boolean,state text);CREATE SCHEMA workflow_integration;`);
 await pg.query('INSERT INTO jobs VALUES($1,$2,$3,$4,$5,false,$6)',[scope.jobId,scope.tenantId,scope.environment,scope.workflowRunId,'text_eval','running']);
 for(const path of ['packages/core/src/evals/data/persistence-migrations/002-data-operations.sql','apps/web/migrations/007-workflow-resumption.sql'])await pg.exec(readFileSync(join(process.env.WORKFLOW_STAGE!,path),'utf8'));
 // The driver lists tasks; the real bridge fixture separately covers their complete schema.
 await pg.exec('CREATE TABLE evaluation_data_persistence.tasks(task_id text,tenant_id uuid,job_id uuid)');
 s.sql={query:(q:string,p:any[])=>pg.query(q,p),transaction:(fn:any)=>pg.transaction(tx=>fn({query:(q:string,p:any[])=>tx.query(q,p)}))};
 s.job={id:scope.jobId,customerId:scope.tenantId,environment:'test',workflowRunId:scope.workflowRunId,state:'running',isMock:false,package:'text_eval'};
 const suite={digest:'a'.repeat(64),scenarios:Array.from({length:12},(_,i)=>({id:`s${i}`}))};
 const provenance={taskId:'approved-task',sourceIds:['private-source'],privateApproval:{receipt:'approved-receipt'}};
 const run={runId:`run:${scope.jobId}:baseline`,executions:[]};
 s.api={job:{jobId:scope.jobId,customerId:scope.tenantId,environment:'test'},intake:{package:'text_eval',endpoint:{systemPrompt:'prompt'}},knownSecrets:[],inventory:{touch:vi.fn(),phase:async(_a:unknown,fn:any)=>fn(),acquisition:vi.fn()},
 advanceData:vi.fn(async()=>({status:'waiting_for_review'})),approvedData:vi.fn(async()=>({suite,provenance})),
 text:{getSuite:vi.fn(async()=>suite),designSuite:vi.fn(),runSuite:vi.fn(async()=>{s.order.push('baseline');return run;}),investigate:vi.fn(async()=>({investigatorStatus:'completed',findings:[],limitations:[]})),reportInput:vi.fn(async()=>({richFindings:[],limitations:['Factual checks remain unassessed.']}))},bindTextBaseline:vi.fn(),remediation:{proposeAndVerifyFixDetailed:vi.fn()},renderReport:vi.fn(async()=>({markdown:'Draft fixture',findings:[]})),dispose:vi.fn()};
 s.selection.mockImplementation(async()=>{s.order.push('selection');return {authorizationId:'supported-pack-approval'};});s.authorize.mockImplementation(async()=>{s.order.push('authorization');return {};});
 s.pack.mockResolvedValue({pack:{status:'pass',results:[{id:'rt_supported',status:'pass'}]}});
});
afterEach(async()=>{await pg.close();});
it('authenticated review wakes the original workflow, admits approved data, then authorizes enabled supported pack before baseline',async()=>{
 expect(await richEvaluationStep(scope.jobId,scope.workflowRunId)).toBe('review_pending');expect(s.api.text.runSuite).not.toHaveBeenCalled();expect(s.selection).not.toHaveBeenCalled();
 const task={taskId:'review-task',jobId:scope.jobId,description:'Offline review',targetId:'target',factualAnswersRequired:false,requirements:[]};const batch={sources:[],cases:[]};const digest=dataReviewRequestDigest(task,batch);
 const operations=createPostgresDataOperationLedger(s.sql,{tenantId:scope.tenantId,jobId:scope.jobId,ownerId:'data_service',authenticateOwner:async()=>({ownerId:'data_service'})});
 await createAuthenticatedDataReviewLedger({operations,authenticateHuman:async()=>({principalId:'independent_human'})}).submit({receiptId:'receipt',task,candidates:batch,reviewed:batch,decision:'approved'});
 await enqueueReviewResume(s.sql,scope,digest);expect(await reviewWakeReady(s.sql,scope)).toBe(true);
 const admitted=await s.api.approvedData();s.api.advanceData.mockResolvedValue({status:'ready',frozen:admitted});s.api.approvedData.mockClear();
 expect(await richEvaluationStep(scope.jobId,scope.workflowRunId)).toBe('complete');
 expect(await reviewWakeReady(s.sql,scope)).toBe(false);expect((await pg.query<{status:string}>('SELECT status FROM workflow_integration.review_resume_intents')).rows[0].status).toBe('finished');
 expect(s.order).toEqual(['selection','authorization','baseline']);expect(s.api.text.designSuite).not.toHaveBeenCalled();expect(s.api.text.getSuite).toHaveBeenCalledWith(expect.anything(),admitted.suite.digest);
 expect(s.api.approvedData).toHaveBeenCalledWith(expect.anything(),admitted.suite.digest);expect(s.api.bindTextBaseline).toHaveBeenCalledWith(admitted.suite.digest,`run:${scope.jobId}:baseline`);
 expect(s.authorize.mock.calls[0][0]).toMatchObject({workflowRunId:scope.workflowRunId,baseSuite:admitted.suite,baseRun:null});expect(s.pack.mock.calls[0][0]).toMatchObject({workflowRunId:scope.workflowRunId,baseSuite:admitted.suite});
 expect(s.artifact.mock.calls[0][3]).toMatchObject({suite:admitted.suite,dataProvenance:admitted.provenance,appendedPack:{pack:{status:'pass'}}});expect(s.persist).toHaveBeenCalledOnce();
 expect((await pg.query<{workflow_run_id:string}>('SELECT workflow_run_id FROM jobs')).rows[0].workflow_run_id).toBe(scope.workflowRunId);
 // Neither admission nor wake fabricated a text suite/design checkpoint.
 expect((await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='text_integration'")).rows).toHaveLength(0);
});
