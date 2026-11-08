import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {readStructuredProgress} from '@structured';
import {publishStructuredInventory} from '@writer';
const time='2026-11-07T10:00:00.000Z';
const job={id:'job',customer_id:'tenant',state:'running',updated_at:time};
const scope={subjectId:'viewer',jobId:'job'};const key=Buffer.alloc(32,7);
let db:PGlite;
let queries:Array<{sql:string,params?:unknown[]}>;
const tx={query:async <T>(sql:string,params?:unknown[])=>{queries.push({sql,params});return db.query<T>(sql,params);}};
let plan:{checkpoints:any[],acquisitionTaskIds:string[]};
async function inventory(){await db.query('INSERT INTO structured_progress.inventory VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id) DO UPDATE SET plan=$5, observed_at=$6',['tenant','job','test',1,JSON.stringify(plan),time]);}
function checkpoint(format='text_run'){
  const calendar=format.startsWith('calendar');const investigation=format.endsWith('investigation');
  return {key:{jobId:'job',kind:investigation?(calendar?'calendar_investigation':'investigation'):(calendar?'calendar_run':'run_result'),id:'operation',inputDigest:'a'.repeat(64)},phase:investigation?'investigating':'running',format,runId:'run',suiteDigest:calendar?'suite':'b'.repeat(64),scenarioIds:['S01'],...(calendar?{branchId:'branch'}:{})};
}
async function save(p:any,value:unknown){await db.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,$2,$3,$4,$5,'completed',$6)`,['job',p.key.kind,p.key.id,p.key.inputDigest,'token',JSON.stringify(value)]);}
function textValue(status='pass'){return {environment:'test',run:{schemaVersion:'text_run.v1',jobId:'job',suiteDigest:'b'.repeat(64),versionLabel:'v1',runId:'run',startedAt:time,completedAt:time,executions:[{scenarioId:'S01',runId:'run',attempt:'initial',outcome:'completed',target:{ok:true,errorCode:null,latencyMs:1},responseText:'PRIVATE RAW RESPONSE',responseClipped:false,startedAt:time,completedAt:time,checks:[{checkId:'S01.o1',kind:'objective',status,detail:'PRIVATE DETAIL',evidenceQuotes:[],reason:null}]}]}};}
function calendarValue(outcome='infrastructure_error'){return {jobId:'job',runId:'run',suiteHash:'suite',branchId:'branch',versionLabel:'v1',results:[{scenarioId:'S01',scope:{jobId:'job',version:'v1',runId:'scenario-run'},outcome,reason:'PRIVATE PROVIDER ERROR'}]};}
const read=()=>readStructuredProgress(tx,scope,job,key,[]);
beforeEach(async()=>{db=new PGlite();queries=[];plan={checkpoints:[checkpoint('text_investigation')],acquisitionTaskIds:[]};
 await db.exec('CREATE TABLE jobs(id text PRIMARY KEY,customer_id text,package text,environment text); INSERT INTO jobs VALUES(\'job\',\'tenant\',\'text_eval\',\'test\')');
 for(const f of ['evals/integration/migrations/001-text-integration.sql','evals/data/persistence-migrations/001-evaluation-data.sql'])await db.exec(readFileSync(join(process.env.STRUCTURED_STAGE!,'packages/core/src',f),'utf8'));
 await db.exec(readFileSync(join(process.env.STRUCTURED_STAGE!,'structured-verification/inventory.sql'),'utf8'));
});afterEach(async()=>{await db.close();});
describe('actual app durable SQL reader over local PostgreSQL engine',()=>{
 it('keeps Trace path and refuses structured jobs without authoritative inventory',async()=>{
  await expect(read()).rejects.toMatchObject({code:'invalid_snapshot'});
  await db.query('UPDATE jobs SET package=$1',['trace_audit']);expect(await read()).toBeNull();
 });
 it('reads a persisted Text checkpoint through core projection without exposing response/prose',async()=>{
  const p=checkpoint();plan.checkpoints=[p];await inventory();await save(p,textValue('not_assessed'));
  const s=await read();expect(s!.status).toBe('running');expect(s!.observedAt).toBe(time);expect(s!.unknownCosts).toBe(true);expect(s!.blockers).toHaveLength(1);expect(s!.milestones[0].milestone).toBe('running');expect(JSON.stringify(s)).not.toContain('PRIVATE');
  expect(queries.some(q=>q.sql.includes('FROM text_integration.checkpoints'))).toBe(true);
 });
 it.each(['text_investigation','calendar_investigation'])('keeps missing %s as a blocker',async format=>{
  if(format.startsWith('calendar'))await db.query('UPDATE jobs SET package=$1',['workflow_eval']);plan.checkpoints=[checkpoint(format)];await inventory();const s=await read();expect(s!.blockers.length).toBeGreaterThan(0);expect(s!.milestones).toEqual([]);
 });
 it('projects saved blocked Text investigation without copying sensitive explanations',async()=>{
  const p=checkpoint('text_investigation');plan.checkpoints=[p];await inventory();await save(p,{investigatorStatus:'credential_refused',findings:[],testDefects:[],reproductions:[],reason:'PRIVATE TOKEN'});
  const s=await read();expect(s!.blockers.length).toBeGreaterThan(0);expect(JSON.stringify(s)).not.toContain('PRIVATE');
 });
 it('preserves Calendar infrastructure uncertainty and rejects frozen branch mismatch',async()=>{
  await db.query('UPDATE jobs SET package=$1',['workflow_eval']);const p=checkpoint('calendar_run');plan.checkpoints=[p];await inventory();await save(p,calendarValue());
  const s=await read();expect(s!.blockers.length).toBeGreaterThan(0);expect(JSON.stringify(s)).not.toContain('PRIVATE');
  plan.checkpoints[0].branchId='different';await inventory();await expect(read()).rejects.toMatchObject({code:'invalid_snapshot'});
 });
 it('rejects saved run digest mismatch instead of returning a clean partial count',async()=>{
  const p=checkpoint();plan.checkpoints=[p];await inventory();await save(p,textValue());await db.query('UPDATE text_integration.checkpoints SET input_digest=$1',['c'.repeat(64)]);await expect(read()).rejects.toThrow();
 });
 it('scopes inventory to tenant/job and exposes stable viewer-specific opaque references',async()=>{
  const p=checkpoint();plan.checkpoints=[p];await inventory();await save(p,textValue());
  const a=await read();const b=await read();expect(a).toEqual(b);
  const other=await readStructuredProgress(tx,{...scope,subjectId:'other'},job,key,[]);expect(other!.statusEvidenceRef).not.toBe(a!.statusEvidenceRef);
  expect(a!.statusEvidenceRef).toMatch(/^ev_[a-f0-9]{64}$/);
  await db.query('UPDATE structured_progress.inventory SET tenant_id=$1',['wrong']);await expect(read()).rejects.toMatchObject({code:'invalid_snapshot'});
 });
 it('treats missing evaluation-data records as durable input blockers',async()=>{
  plan.checkpoints=[];plan.acquisitionTaskIds=['task'];await inventory();const s=await read();expect(s!.blockers.some(b=>b.kind==='input')).toBe(true);
  const q=queries.find(q=>q.sql.includes('evaluation_data_persistence.tasks'));expect(q?.params).toEqual(['tenant','job','task']);
 });
 it.each(['waiting_for_data','waiting_for_expert'])('reads SQL %s blockers without leaking data',async state=>{
  plan.acquisitionTaskIds=['task'];await inventory();const record={taskId:'task',revision:0,requestHash:'c'.repeat(64),spec:{taskId:'task',jobId:'job',description:'PRIVATE DATA',requirements:[],targetId:'private-target',factualAnswersRequired:false},state,phase:'expert',sources:[],cases:[],decisions:[],updatedAt:time,assessment:{status:'insufficient',factualCorrectness:'unassessed',acceptedCaseIds:[],approvedAnswerCaseIds:[],coverage:[],issues:[]}};
  await db.query('INSERT INTO evaluation_data_persistence.tasks VALUES($1,$2,$3,$4,$5)',['tenant','job','task',0,JSON.stringify(record)]);const s=await read();expect(s!.blockers.some(b=>b.kind==='input')).toBe(true);expect(JSON.stringify(s)).not.toContain('PRIVATE');
 });
 it('rejects a stale inventory watermark behind included job or app cost rows',async()=>{
  await inventory();const newer='2026-11-07T11:00:00.000Z';
  await expect(readStructuredProgress(tx,scope,{...job,updated_at:newer},key,[])).rejects.toMatchObject({code:'invalid_snapshot'});
  await expect(readStructuredProgress(tx,scope,job,key,[],newer)).rejects.toMatchObject({code:'invalid_snapshot'});
 });
 it('uses a stored watermark and refuses delivery while a checkpoint remains unresolved',async()=>{
  plan.checkpoints=[checkpoint()];await inventory();const s=await read();expect(s!.observedAt).toBe(time);
  await expect(readStructuredProgress(tx,scope,{...job,state:'delivered'},key,[])).rejects.toMatchObject({code:'invalid_snapshot'});
 });
});

describe('server Workflow inventory publisher on actual SQL',()=>{
 it('publishes actual stable identity and uses CAS revisions with immutable frozen associations',async()=>{
  const p=checkpoint();plan.checkpoints=[p];await save(p,textValue());
  const authorized={tenantId:'tenant',jobId:'job',environment:'test' as const};
  expect(await publishStructuredInventory(tx,authorized,null,plan)).toBe(0);
  expect(await publishStructuredInventory(tx,authorized,0,plan)).toBe(1);
  await expect(publishStructuredInventory(tx,authorized,0,plan)).rejects.toMatchObject({code:'invalid_snapshot'});
  const changed=structuredClone(plan);changed.checkpoints[0].suiteDigest='c'.repeat(64);
  await expect(publishStructuredInventory(tx,authorized,1,changed)).rejects.toMatchObject({code:'invalid_snapshot'});
  const row=(await db.query<{revision:number,observed_at:Date}>('SELECT revision,observed_at FROM structured_progress.inventory')).rows[0];
  expect(Number(row.revision)).toBe(1);expect(Number.isFinite(new Date(row.observed_at).getTime())).toBe(true);
 });
 it('records trusted expected missing checkpoints and tasks without fabricating completion',async()=>{
  plan.checkpoints=[checkpoint()];plan.acquisitionTaskIds=['planned-task'];
  expect(await publishStructuredInventory(tx,{tenantId:'tenant',jobId:'job',environment:'test'},null,plan)).toBe(0);
  const snapshot=await read();expect(snapshot!.blockers.length).toBe(2);expect(snapshot!.milestones).toEqual([]);
 });
 it('rejects observed checkpoint identity disagreement and wrong tenant before publication',async()=>{
  const p=checkpoint();plan.checkpoints=[p];await save(p,textValue());
  const bad=structuredClone(plan);bad.checkpoints[0].key.inputDigest='d'.repeat(64);
  await expect(publishStructuredInventory(tx,{tenantId:'tenant',jobId:'job',environment:'test'},null,bad)).rejects.toMatchObject({code:'invalid_snapshot'});
  await expect(publishStructuredInventory(tx,{tenantId:'wrong',jobId:'job',environment:'test'},null,plan)).rejects.toMatchObject({code:'invalid_snapshot'});
  expect((await db.query('SELECT * FROM structured_progress.inventory')).rows).toEqual([]);
 });
});
