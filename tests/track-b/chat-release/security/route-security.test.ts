import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {GET,POST} from '@route';
import {encryptJson} from '@ae/core/storage/crypto';
import {fixtureDatabase} from './fixture-pool';
import {fixtureSession} from './fixture-session';
const job='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const ctx=(jobId=job)=>({params:Promise.resolve({jobId})});
const url=(id=job)=>`https://app.example/api/jobs/${id}/chat`;
const get=(query='',id=job)=>GET(new Request(url(id)+query),ctx(id));
const send=(messageId='stable',text='progress',origin='https://app.example',extra={})=>POST(new Request(url(),{method:'POST',headers:{origin},body:JSON.stringify({messageId,text,...extra})}),ctx());
const count=async()=>Number((await fixtureDatabase.db.query('SELECT count(*) n FROM reporting_chat_exchanges')).rows[0].n);
beforeEach(async()=>{
 process.env.DATABASE_URL='postgres://fixture-never-connect';process.env.CREDENTIALS_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
 fixtureSession.viewer={id:'owner',isOperator:false};fixtureDatabase.db=new PGlite();fixtureDatabase.queries=[];
 await fixtureDatabase.db.exec(`CREATE TABLE jobs(id text PRIMARY KEY,customer_id text,state text,updated_at timestamptz,package text,environment text);
 INSERT INTO jobs VALUES('${job}','owner','running','2026-11-07T10:00:00Z','trace_audit','test'),('${other}','other','running','2026-11-07T10:00:00Z','trace_audit','test');
 CREATE TABLE job_credentials(job_id text,ciphertext text);CREATE TABLE job_github_targets(job_id text,token_ciphertext text);
 CREATE TABLE progress_events(id text,job_id text,milestone text,created_at timestamptz);
 CREATE TABLE findings(id text,job_id text,data jsonb,created_at timestamptz,rerun_of_finding_id text);
 CREATE TABLE costs(id text,job_id text,source text,micro_usd bigint,created_at timestamptz);`);
 await fixtureDatabase.db.exec(readFileSync(join(process.env.SECURITY_REPO!,'docs/progress-chat-integration/server/001-private-conversations.sql'),'utf8'));
 await fixtureDatabase.db.exec(readFileSync(join(process.env.SECURITY_REPO!,'docs/structured-progress-integration/backend/001-structured-progress.sql'),'utf8'));
 for(const f of ['evals/integration/migrations/001-text-integration.sql','evals/data/persistence-migrations/001-evaluation-data.sql'])await fixtureDatabase.db.exec(readFileSync(join(process.env.SECURITY_STAGE!,'packages/core/src',f),'utf8'));
});afterEach(async()=>fixtureDatabase.db.close());
it('dispatches actual route/adapter/core/SQL while running and delivered, with immutable retry and paginated history',async()=>{
 const first=await send();expect(first.status).toBe(200);const one=await first.json();expect((await (await send()).json())).toEqual(one);expect(await count()).toBe(1);
 expect((await send('stable','cost')).status).toBe(409);expect(await count()).toBe(1);
 const poll=await (await get('?mode=poll')).json();expect(poll.reply.text).toContain('running');expect(poll.reply.text).toContain('unknown');
 expect((await (await get('?mode=poll&cursor='+poll.cursor)).json()).changed).toBe(false);expect(await count()).toBe(1);
 await fixtureDatabase.db.query('UPDATE jobs SET state=$1 WHERE id=$2',['delivered',job]);
 expect((await (await get('?mode=poll')).json()).reply.text).toContain('delivered');
 expect((await send('second','cost')).status).toBe(200);
 const page=await (await get('?limit=1')).json();expect(page.exchanges).toHaveLength(1);expect(page.hasMore).toBe(true);
 const next=await (await get('?limit=1&afterSequence='+page.nextAfterSequence)).json();expect(next.exchanges[0].sequence).toBeGreaterThan(page.exchanges[0].sequence);
 expect((await (await get('?afterSequence='+next.nextAfterSequence)).json()).exchanges).toEqual([]);
 expect(fixtureDatabase.queries.some(q=>q.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).toBe(true);
 expect(fixtureDatabase.queries.some(q=>q.sql==='BEGIN ISOLATION LEVEL READ COMMITTED')).toBe(true);
});
it('uses actual SQL ownership, keeps operator conversation distinct, and denies public-share authentication',async()=>{
 await send();fixtureSession.viewer={id:'other',isOperator:false};expect((await get()).status).toBe(404);expect((await send()).status).toBe(404);
 fixtureSession.viewer=null;expect((await get('?share=public-token')).status).toBe(401);expect((await send()).status).toBe(401);
 fixtureSession.viewer={id:'operator',isOperator:true};expect((await (await get()).json()).exchanges).toEqual([]);expect((await send()).status).toBe(200);expect(await count()).toBe(2);
 fixtureSession.viewer={id:'owner',isOperator:false};expect((await (await get()).json()).exchanges).toHaveLength(1);expect((await get('',other)).status).toBe(404);
 expect((await fixtureDatabase.db.query('SELECT subject_id FROM reporting_chat_exchanges ORDER BY subject_id')).rows).toEqual([{subject_id:'operator'},{subject_id:'owner'}]);
});
it('rescreens stored history and stable retries against newly configured current credentials',async()=>{
 await send();const reply=(await fixtureDatabase.db.query('SELECT reply FROM reporting_chat_exchanges')).rows[0].reply;
 await fixtureDatabase.db.query('INSERT INTO job_credentials VALUES($1,$2)',[job,encryptJson({secret:'running'})]);
 expect(reply.text).toContain('running');expect((await get()).status).toBe(503);expect((await send()).status).toBe(503);
 expect(await count()).toBe(1);
 await fixtureDatabase.db.query('DELETE FROM job_credentials');
 await fixtureDatabase.db.query("UPDATE reporting_chat_exchanges SET reply=jsonb_set(reply,'{text}',to_jsonb('new-private-secret'::text))");
 await fixtureDatabase.db.query('INSERT INTO job_credentials VALUES($1,$2)',[job,encryptJson({secret:'new-private-secret'})]);
 expect((await get()).status).toBe(503);expect((await send()).status).toBe(503);
 expect(await (await get()).text()).not.toContain('new-private-secret');
});
it('rejects cross-origin, injected caller identity, oversized body and invalid pagination without writing',async()=>{
 expect((await send('x','progress','https://evil.example')).status).toBe(400);
 expect((await send('x','progress','https://app.example',{subjectId:'operator'})).status).toBe(400);
 expect((await send('x','a'.repeat(12001))).status).toBe(400);
 expect((await get('?limit=1e2')).status).toBe(400);expect(await count()).toBe(0);
});
it('fails closed without authoritative structured inventory; missing checkpoint becomes a bounded blocker',async()=>{
 await fixtureDatabase.db.query('UPDATE jobs SET package=$1 WHERE id=$2',['text_eval',job]);expect((await get('?mode=poll')).status).toBe(503);
 const plan={checkpoints:[{key:{jobId:job,kind:'design',id:'suite',inputDigest:'a'.repeat(64)},phase:'planning',format:'text_design'}],acquisitionTaskIds:[]};
 await fixtureDatabase.db.query('INSERT INTO structured_progress.inventory VALUES($1,$2,$3,$4,$5,$6)',['owner',job,'test',1,JSON.stringify(plan),'2026-11-07T10:00:00Z']);
 const p=await get('?mode=poll');expect(p.status).toBe(200);const body=await p.json();expect(body.reply.text).toMatch(/block|unknown|missing/i);
 await fixtureDatabase.db.query('INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,$2,$3,$4,$5,$6,$7)',[job,'design','suite','a'.repeat(64),'private-token','completed',JSON.stringify({status:'blocked',reason:'PRIVATE DATA'})]);
 const b=await get('?mode=poll');expect(b.status).toBe(200);expect(await b.text()).not.toContain('PRIVATE DATA');expect(await count()).toBe(0);
});
it.each(['text','calendar'])('delivers persisted confirmed %s findings through actual authenticated route without checkpoint prose',async kind=>{
 const calendar=kind==='calendar', time='2026-11-07T10:00:00.000Z';
 await fixtureDatabase.db.query('UPDATE jobs SET package=$1 WHERE id=$2',[calendar?'workflow_eval':'text_eval',job]);
 const base={key:{jobId:job,kind:calendar?'calendar_run':'run_result',id:'operation',inputDigest:'a'.repeat(64)},phase:'running',format:calendar?'calendar_run':'text_run',runId:'run',suiteDigest:calendar?'suite':'b'.repeat(64),scenarioIds:['S01'],...(calendar?{branchId:'branch'}:{})};
 const investigation={...base,key:{...base.key,kind:calendar?'calendar_investigation':'investigation',id:'run'},phase:'investigating',format:calendar?'calendar_investigation':'text_investigation'};
 await fixtureDatabase.db.query('INSERT INTO structured_progress.inventory VALUES($1,$2,$3,$4,$5,$6)',['owner',job,'test',1,JSON.stringify({checkpoints:[base,investigation],acquisitionTaskIds:[]}),time]);
 const save=async(p:any,value:any)=>fixtureDatabase.db.query('INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,$2,$3,$4,$5,$6,$7)',[job,p.key.kind,p.key.id,p.key.inputDigest,'private-token','completed',JSON.stringify(value)]);
 if(calendar){
  const source={scenarioId:'S01',scope:{jobId:job,version:'v1',runId:'scenario-run'},outcome:'product_failure',reason:'PRIVATE PROVIDER ERROR'};
  const original={jobId:job,runId:'run',suiteHash:'suite',branchId:'branch',versionLabel:'v1',results:[source]};
  const rerun={...source,scope:{...source.scope,runId:'repro-run'}};
  await save(base,original);await save(investigation,{original,pendingScenarioIds:[],reproductions:[{originalScenarioId:'S01',result:rerun}],findings:[{id:'f1',scenarioId:'S01',status:'confirmed',severity:'medium',reproductions:1,description:'PRIVATE',association:{jobId:job,branchId:'branch',suiteHash:'suite',scope:source.scope,reproductionScope:rerun.scope}}]});
 }else{
  const execution={scenarioId:'S01',runId:'run',attempt:'initial',outcome:'completed',target:{ok:true,errorCode:null,latencyMs:1},responseText:'PRIVATE RESPONSE',responseClipped:false,startedAt:time,completedAt:time,checks:[{checkId:'S01.o1',kind:'objective',status:'fail',detail:'PRIVATE',evidenceQuotes:[],reason:null}]};
  await save(base,{environment:'test',run:{schemaVersion:'text_run.v1',jobId:job,suiteDigest:'b'.repeat(64),versionLabel:'v1',runId:'run',startedAt:time,completedAt:time,executions:[execution]}});
  await save(investigation,{investigatorStatus:'completed',testDefects:[],reproductions:[{...execution,runId:'repro-run',attempt:'reproduction'}],findings:[{id:'text:S01:S01.o1',source:'text_eval',category:'explicit_constraint',title:'PRIVATE',summary:'PRIVATE',label:'confirmed',severity:'high',basis:'objective',investigatorNote:null,evidence:[{kind:'check',checkId:'S01.o1',detail:'PRIVATE'}],reproduction:{attempted:true,reproduced:true,runId:'repro-run'}}]});
 }
 const response=await send('findings','findings');expect(response.status).toBe(200);const body=await response.json();expect(body.exchange.reply.text).toMatch(/1 confirmed/);expect(JSON.stringify(body)).not.toContain('PRIVATE');
 const replay=await (await send('findings','findings')).json();expect(replay).toEqual(body);
});
