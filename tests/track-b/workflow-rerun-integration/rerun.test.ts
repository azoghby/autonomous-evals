import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
import {createTextEvaluationServices} from '@ae/core/evals/integration/services';
import {createCalendarEvaluationServices} from '@ae/core/evals/calendar-integration';
import {makeSuite} from '@ae/core/evals/text/__tests__/fixtures';
import {calendarAcceptanceScenarios} from '@ae/core/simulator/acceptance-scenarios';
import {CalendarSimulator} from '@ae/core/simulator/calendar';
import {PostgresCalendarStore} from '@ae/core/simulator/postgres';
const state=vi.hoisted(()=>({loaded:new Map<string,any>()}));
vi.mock('@/server/job-store',()=>({getJobWithDecryptedCredentials:vi.fn(async(id:string)=>state.loaded.get(id)),makeServiceContext:vi.fn()}));
vi.mock('@/server/rich-services',()=>({createRichWorkflowServices:vi.fn(),workflowSql:vi.fn()}));
vi.mock('@/server/services',()=>({getEvalServices:vi.fn()}));
import {executeRerun,loadRerunAuthority} from '@/server/rich-rerun';
let engine:PGlite,db:AgentTransactionalSql;
const stage=process.env.RERUN_STAGE!;
beforeAll(async()=>{
 engine=new PGlite();
 await engine.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id text,environment text,state text,is_mock boolean,workflow_run_id text,package text,neon_branch_id text);
 CREATE TABLE job_credentials(job_id uuid,ciphertext text); CREATE TABLE findings(id uuid PRIMARY KEY,job_id uuid,finding_key text,rerun_of_finding_id uuid);
 CREATE TABLE costs(job_id uuid,micro_usd bigint);CREATE TABLE budget_reservations(job_id uuid,micro_usd bigint,released_at timestamptz);
 CREATE SCHEMA workflow_integration; CREATE TABLE workflow_integration.bindings(job_id uuid,target_revision text);
 CREATE TABLE workflow_integration.rich_artifacts(job_id uuid,tenant_id text,environment text,suite_digest text,body jsonb);`);
 for(const p of ['apps/web/migrations/006-workflow-finding-reruns.sql','packages/core/src/evals/integration/migrations/001-text-integration.sql','packages/core/src/simulator/migrations/001_calendar.sql','packages/core/src/simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql'])await engine.exec(readFileSync(join(stage,p),'utf8'));
 // Serialize one local backend. This proves real SQL semantics, not hosted multi-session locking.
 let tail=Promise.resolve();const serial=<T>(f:()=>Promise<T>)=>{const p=tail.then(f);tail=p.then(()=>{},()=>{});return p;};
 db={query:(s,p)=>serial(()=>engine.query(s,p)),transaction:f=>serial(()=>engine.transaction(tx=>f({query:(s,p)=>tx.query(s,p)})))};
},30000);
afterAll(async()=>{await engine.close()});
async function setup(calendar=false){
 const jobId=randomUUID(),findingId=randomUUID(),ownerId='owner',key='request-0001';
 const job:any={jobId,customerId:ownerId,environment:'test',package:calendar?'workflow_eval':'text_eval',quoteVersion:null,linkedRetestOf:null,isFixture:true};
 const ctx:any={jobId,environment:'test',budgetMicroUsd:1000000,recordCost:vi.fn(async()=>{}),recordProgress:vi.fn(async()=>{})};
 const checkpoints=new PostgresTextCheckpointStore(db),send=vi.fn(async()=>({ok:true,text:'WRONG',latencyMs:1}));
 let version='target-v1';
 const text=createTextEvaluationServices({checkpoints,runner:{run:async()=>{throw Error('No investigator/provider allowed')}},resolve:async()=>({job,target:{send},targetVersion:version,judge:null})});
 let suite:any,run:any,calendarApi:any;
 if(calendar){
 const reviewedSuite:any={jobId,origin:'internal_fixture',frozenAt:'2026-11-07T20:00:00.000Z',review:{reviewerId:'fixture',approved:true},scenarios:calendarAcceptanceScenarios().map(({id,prompt,actorId,seed,checks})=>structuredClone({id,prompt,actorId,seed,checks}))};
 const complete=vi.fn(async()=>({role:'assistant' as const,content:'No action.'}));
 const pool:any={query:db.query,connect:async()=>({query:async(s:string,p:any[])=>s.includes('pg_advisory')?{rows:[]}:db.query(s,p),release(){}})};
 calendarApi=createCalendarEvaluationServices({checkpoints,journalPool:pool,resolve:async()=>({job,targetVersion:version,branch:{jobId,branchId:'owned-branch',targetVersion:version},reviewedSuite,dependencies:{db,simulator:new CalendarSimulator(new PostgresCalendarStore(db)),targetForScenario:()=>({complete})}})});
 suite=await calendarApi.freezeSuite(ctx,{suiteId:'baseline-suite'});run=await calendarApi.runSuite(ctx,{suiteId:'baseline-suite',operationId:'baseline',versionLabel:'default'});
 }else{
 suite=makeSuite({jobId}); // Seed the actual immutable checkpoint as approved admission would.
 const k={jobId,kind:'suite',id:suite.digest,inputDigest:'fixture'};const c=await checkpoints.claim(k);if(c.state!=='claimed')throw Error();await checkpoints.complete(k,c.token,suite);
 // resolveApprovedSuite is the supported core admission seam.
 Object.assign(text,{});
 }
 const admittedText=calendar?text:createTextEvaluationServices({checkpoints,runner:{run:async()=>{throw Error('No provider')}},resolveApprovedSuite:async()=>suite,resolve:async()=>({job,target:{send},targetVersion:version,judge:null})});
 if(!calendar)run=await admittedText.runSuite(ctx,{suiteDigest:suite.digest,runId:'baseline'});
 const baseline={format:calendar?'rich_calendar.v1':'rich_text_remediation.v1',suite,run,investigation:{findings:[{id:'rich-finding'}]}};
 await db.query(`INSERT INTO jobs VALUES($1,$2,'test','delivered',false,'wf',$3,'owned-branch')`,[jobId,ownerId,job.package]);
 await db.query('INSERT INTO job_credentials VALUES($1,$2)',[jobId,'current-ciphertext']);
 await db.query('INSERT INTO workflow_integration.bindings VALUES($1,$2,$3)',[jobId,'revision',100]);
 await db.query('INSERT INTO findings VALUES($1,$2,$3,NULL)',[findingId,jobId,'rich-finding']);
 await db.query(`INSERT INTO workflow_integration.rich_artifacts VALUES($1,$2,'test',$3,$4::jsonb)`,[jobId,ownerId,suite.digest??suite.hash,JSON.stringify(baseline)]);
 state.loaded.set(jobId,{job:{customerId:ownerId,environment:'test'},intake:{endpoint:{url:'https://offline.invalid',model:'scripted'}},credentials:{apiKey:'secret-local-only'}});
 const api:any={text:admittedText,calendar:calendarApi,dispose:vi.fn(async()=>{})};
 const deps:any={context:async()=>ctx,services:async()=>api,check:async()=>{}};
 return {request:{jobId,findingId,ownerId,key},deps,ctx,send,baseline,api,rotate:()=>{version='target-v2'}};
}
it('offline real SQL + scripted Text target: complete rich outcomes, stable replay, immutable baseline',async()=>{
 const f=await setup(),before=JSON.stringify(f.baseline);const r=await executeRerun(db,f.request,f.deps);
 expect(r.state).toBe('completed');expect((r.result as any).run.executions).toHaveLength(12);expect((r.result as any).run.executions[0].checks[0].status).toBe('fail');
 expect(f.send).toHaveBeenCalledTimes(24);const replay=await executeRerun(db,f.request,f.deps);expect(replay.result).toEqual(r.result);expect(f.send).toHaveBeenCalledTimes(24);const holds=await db.query<any>('SELECT count(*) AS n,sum(hold_micro_usd) AS held FROM workflow_integration.finding_reruns WHERE job_id=$1',[f.request.jobId]);expect(Number(holds.rows[0].n)).toBe(1);expect(Number(holds.rows[0].held)).toBe(100);expect(JSON.stringify(f.baseline)).toBe(before);
 const row=await db.query<any>('SELECT body FROM workflow_integration.rich_artifacts WHERE job_id=$1',[f.request.jobId]);expect(row.rows[0].body).toEqual(f.baseline);
});
it('offline real simulator + Calendar adapter reruns retained twelve after target version changes',async()=>{
 const f=await setup(true);f.rotate();const r=await executeRerun(db,f.request,f.deps);expect(r.state).toBe('completed');expect((r.result as any).run.results).toHaveLength(12);expect((r.result as any).run.results.some((r:any)=>r.outcome==='product_failure')).toBe(true);expect((r.result as any).limitations[0]).toContain('reproduction');
});
it('cross-user, deleted credentials, altered finding association and unsupported trace fail before dispatch',async()=>{
 const f=await setup();await expect(executeRerun(db,{...f.request,ownerId:'other'},f.deps)).rejects.toThrow();
 await db.query('UPDATE findings SET finding_key=$2 WHERE id=$1',[f.request.findingId,'tampered']);await expect(loadRerunAuthority(db,f.request)).rejects.toThrow();
 await db.query('UPDATE findings SET finding_key=$2 WHERE id=$1',[f.request.findingId,'rich-finding']);await db.query('DELETE FROM job_credentials WHERE job_id=$1',[f.request.jobId]);await expect(loadRerunAuthority(db,f.request)).rejects.toThrow();expect(f.send).toHaveBeenCalledTimes(12);
});
it('concurrent same key dispatches once and different keys include pending in max-three admission',async()=>{
 const f=await setup();let release!:()=>void;const gate=new Promise<void>(r=>release=r);f.deps.check=()=>gate;
 const same=[executeRerun(db,f.request,f.deps),executeRerun(db,f.request,f.deps)];
 const other=[2,3,4].map(i=>executeRerun(db,{...f.request,key:`request-000${i}`},f.deps));
 // SQL admission completes while dispatch remains held.
 const settled=Promise.allSettled([...same,...other]);await new Promise(r=>setTimeout(r,30));release();const results=await settled;
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(f.send).toHaveBeenCalledTimes(48);const held=await db.query<any>('SELECT sum(hold_micro_usd) AS n FROM workflow_integration.finding_reruns WHERE job_id=$1',[f.request.jobId]);expect(Number(held.rows[0].n)).toBe(300);
});
it('lost completion ack replays committed result, while interrupted claim never redispatches',async()=>{
 const f=await setup();let lost=true;
 const ackDb:AgentTransactionalSql={...db,query:async(s,p)=>{const r=await db.query(s,p);if(lost&&s.includes("SET state='completed'")){lost=false;throw Error('lost ack')}return r as any;}};
 expect((await executeRerun(ackDb,f.request,f.deps)).state).toBe('needs_operator');expect((await executeRerun(db,f.request,f.deps)).state).toBe('completed');expect(f.send).toHaveBeenCalledTimes(24);
 const g=await setup();g.deps.check=async()=>{throw Error('worker lost')};expect((await executeRerun(db,g.request,g.deps)).state).toBe('needs_operator');g.deps.check=async()=>{};expect((await executeRerun(db,g.request,g.deps)).state).toBe('needs_operator');expect(g.send).toHaveBeenCalledTimes(12);
});
it('same key changed finding or rotated/revoked authority rejects; keyless old clients do not dispatch',async()=>{
 const f=await setup();await expect(executeRerun(db,{...f.request,key:''},f.deps)).rejects.toThrow('Idempotency');await executeRerun(db,f.request,f.deps);
 await db.query('UPDATE job_credentials SET ciphertext=$2 WHERE job_id=$1',[f.request.jobId,'rotated']);await expect(executeRerun(db,f.request,f.deps)).rejects.toThrow('authority changed');
 await db.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[f.request.jobId]);await expect(executeRerun(db,f.request,f.deps)).rejects.toThrow();
});
it('explicit trace/pack, missing original branch, and budget/checkTarget refusals do not run targets',async()=>{
 const f=await setup();await db.query("UPDATE jobs SET package='trace_audit' WHERE id=$1",[f.request.jobId]);await expect(executeRerun(db,f.request,f.deps)).rejects.toThrow('Unsupported');
 await db.query("UPDATE jobs SET package='text_eval' WHERE id=$1",[f.request.jobId]);await db.query("UPDATE workflow_integration.rich_artifacts SET body=body || '{\"appendedPack\":{\"status\":\"approved\"}}'::jsonb WHERE job_id=$1",[f.request.jobId]);await expect(executeRerun(db,f.request,f.deps)).rejects.toThrow('Unsupported');
 const g=await setup(true);await db.query('UPDATE jobs SET neon_branch_id=NULL WHERE id=$1',[g.request.jobId]);await expect(executeRerun(db,g.request,g.deps)).rejects.toThrow('branch');
 const h=await setup();await db.query('UPDATE workflow_integration.bindings SET rerun_operation_micro_usd=900000000 WHERE job_id=$1',[h.request.jobId]);await expect(executeRerun(db,h.request,h.deps)).rejects.toThrow('budget');expect(h.send).toHaveBeenCalledTimes(12);
 const i=await setup();i.deps.check=async()=>{throw Error('Target policy denied')};expect((await executeRerun(db,i.request,i.deps)).state).toBe('needs_operator');expect(i.send).toHaveBeenCalledTimes(12);
});
it('changed finding under the same key rejects instead of selecting a new scenario',async()=>{
 const f=await setup();await executeRerun(db,f.request,f.deps);const id=randomUUID();await db.query('INSERT INTO findings VALUES($1,$2,$3,NULL)',[id,f.request.jobId,'rich-finding']);await expect(executeRerun(db,{...f.request,findingId:id},f.deps)).rejects.toThrow('input');expect(f.send).toHaveBeenCalledTimes(24);
});
it('legacy saved reruns count toward the same three-operation limit',async()=>{
 const f=await setup();for(let n=0;n<3;n++)await db.query('INSERT INTO findings VALUES($1,$2,$3,$4)',[randomUUID(),f.request.jobId,`legacy-${n}`,f.request.findingId]);await expect(executeRerun(db,f.request,f.deps)).rejects.toThrow('limit');expect(f.send).toHaveBeenCalledTimes(12);
});
