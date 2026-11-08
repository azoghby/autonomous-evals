import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {GET,POST} from '@route';
import {encryptJson} from '@ae/core/storage/crypto';
import {mapSnapshot} from '@/server/progress-chat';
import {fixtureDatabase} from './fixture-pool';
import {fixtureSession} from './fixture-session';
const job='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const ctx=(jobId=job)=>({params:Promise.resolve({jobId})});
const url=(id=job)=>`https://app.example/api/jobs/${id}/chat`;
const get=(query='',id=job)=>GET(new Request(url(id)+query),ctx(id));
const send=(messageId='stable',text='progress',id=job)=>POST(new Request(url(id),{method:'POST',headers:{origin:'https://app.example'},body:JSON.stringify({messageId,text})}),ctx(id));
const count=async()=>Number((await fixtureDatabase.db.query('SELECT count(*) n FROM reporting_chat_exchanges')).rows[0].n);
beforeEach(async()=>{
 process.env.DATABASE_URL='postgres://fixture-never-connect';process.env.CREDENTIALS_ENCRYPTION_KEY=Buffer.alloc(32,19).toString('base64');
 fixtureSession.viewer={id:'owner',isOperator:false};fixtureDatabase.db=new PGlite();fixtureDatabase.queries=[];fixtureDatabase.afterQuery=undefined;
 await fixtureDatabase.db.exec(`CREATE TABLE jobs(id text PRIMARY KEY,customer_id text,state text,updated_at timestamptz,package text,environment text);
 INSERT INTO jobs VALUES('${job}','owner','running','2026-11-07T10:00:00Z','trace_audit','test'),('${other}','other','running','2026-11-07T10:00:00Z','trace_audit','test');
 CREATE TABLE job_credentials(job_id text,ciphertext text);CREATE TABLE job_github_targets(job_id text,token_ciphertext text);
 CREATE TABLE progress_events(id text,job_id text,milestone text,created_at timestamptz);
 CREATE TABLE findings(id text,job_id text,data jsonb,created_at timestamptz,rerun_of_finding_id text);
 CREATE TABLE costs(id text,job_id text,source text,micro_usd bigint,created_at timestamptz);`);
 for(const f of ['docs/progress-chat-integration/server/001-private-conversations.sql','docs/structured-progress-integration/backend/001-structured-progress.sql'])await fixtureDatabase.db.exec(readFileSync(join(process.env.SECURITY_REPO!,f),'utf8'));
 for(const f of ['evals/integration/migrations/001-text-integration.sql','evals/data/persistence-migrations/001-evaluation-data.sql'])await fixtureDatabase.db.exec(readFileSync(join(process.env.SECURITY_STAGE!,'packages/core/src',f),'utf8'));
});
afterEach(async()=>{fixtureDatabase.afterQuery=undefined;await fixtureDatabase.db.close();});
it('binds opaque evidence references to subject and job and excludes raw event/finding/cost IDs and prose',async()=>{
 const now='2026-11-07T10:00:00Z', key=Buffer.alloc(32,19);
 const source={id:job,customer_id:'owner',state:'running',updated_at:now};
 const events=[{id:'PRIVATE_EVENT_ID',milestone:'planning',created_at:now,message:'PRIVATE_PROSE'}];
 const findings=[{id:'PRIVATE_FINDING_ID',status:'confirmed',severity:'high',created_at:now,summary:'PRIVATE_PROSE'}];
 const costs=[{id:'PRIVATE_COST_ID',source:'ai_gateway',micro_usd:7,created_at:now,metadata:'PRIVATE_PROSE'}];
 const a=mapSnapshot(source,events,findings,costs,key,'owner');
 const b=mapSnapshot(source,events,findings,costs,key,'operator');
 const c=mapSnapshot({...source,id:other},events,findings,costs,key,'owner');
 expect(a.statusEvidenceRef).toMatch(/^ev_[a-f0-9]{64}$/);
 expect(new Set([a.findings[0].id,b.findings[0].id,c.findings[0].id]).size).toBe(3);
 expect(JSON.stringify(a)).not.toContain('PRIVATE_');
 await fixtureDatabase.db.query('INSERT INTO progress_events VALUES($1,$2,$3,$4)',['PRIVATE_EVENT_ID',job,'planning',now]);
 const response=await get('?mode=poll');expect(response.status).toBe(200);expect(await response.text()).not.toContain('PRIVATE_EVENT_ID');
});
it('isolates actual send/history/poll across owner, stranger, public and operator scopes',async()=>{
 expect((await send()).status).toBe(200);expect(await count()).toBe(1);
 for(const mode of ['', '?mode=poll']){
  fixtureSession.viewer={id:'other',isOperator:false};expect((await get(mode)).status).toBe(404);
  expect((await send()).status).toBe(404);
  fixtureSession.viewer=null;const response=await get(mode+'&share=public-token');expect(response.status).toBe(401);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(response.headers.get('Vary')).toBe('Cookie');
 }
 fixtureSession.viewer={id:'operator',isOperator:true};expect((await (await get()).json()).exchanges).toEqual([]);
 expect((await send()).status).toBe(200);
 fixtureSession.viewer={id:'owner',isOperator:false};expect((await (await get()).json()).exchanges).toHaveLength(1);
 expect((await get('',other)).status).toBe(404);expect((await send('cross','progress',other)).status).toBe(404);
 expect((await fixtureDatabase.db.query('SELECT subject_id FROM reporting_chat_exchanges ORDER BY subject_id')).rows).toEqual([{subject_id:'operator'},{subject_id:'owner'}]);
});
it('denies all new requests after ownership transfer or scripted session revocation',async()=>{
 await send();await fixtureDatabase.db.query('UPDATE jobs SET customer_id=$1 WHERE id=$2',['other',job]);
 for(const request of [()=>get(),()=>get('?mode=poll'),()=>send()])expect((await request()).status).toBe(404);
 fixtureSession.viewer=null;for(const request of [()=>get(),()=>get('?mode=poll'),()=>send()])expect((await request()).status).toBe(401);
 expect(await count()).toBe(1);
});
it('rescreens stored retry/history and current poll against a fresh synthetic credential on the next request',async()=>{
 expect((await send()).status).toBe(200);
 await fixtureDatabase.db.query('INSERT INTO job_credentials VALUES($1,$2)',[job,encryptJson({token:'running'})]);
 for(const request of [()=>get(),()=>get('?mode=poll'),()=>send()]){const response=await request();expect(response.status).toBe(503);expect(await response.text()).not.toContain('running');}
 expect(await count()).toBe(1);
});
it('requires authoritative structured inventory and refuses a watermark older than current app progress',async()=>{
 await fixtureDatabase.db.query('UPDATE jobs SET package=$1 WHERE id=$2',['text_eval',job]);
 expect((await get('?mode=poll')).status).toBe(503);
 const plan={checkpoints:[{key:{jobId:job,kind:'design',id:'suite',inputDigest:'a'.repeat(64)},phase:'planning',format:'text_design'}],acquisitionTaskIds:[]};
 await fixtureDatabase.db.query('INSERT INTO structured_progress.inventory VALUES($1,$2,$3,$4,$5,$6)',['owner',job,'test',1,JSON.stringify(plan),'2026-11-07T10:00:00Z']);
 const response=await get('?mode=poll');expect(response.status).toBe(200);expect((await response.json()).reply.text).toMatch(/missing|block|unknown/i);
 await fixtureDatabase.db.query('INSERT INTO progress_events VALUES($1,$2,$3,$4)',['newer-event',job,'running','2026-11-07T10:00:01Z']);
 expect((await get('?mode=poll')).status).toBe(503);expect(await count()).toBe(0);
});
async function sendWithChangeAfterSnapshot(change:()=>Promise<void>){
 let release!:()=>void;const done=new Promise<void>(resolve=>{release=resolve});
 fixtureDatabase.afterQuery=async sql=>{if(sql==='COMMIT'){fixtureDatabase.afterQuery=undefined;await change();release();}};
 const stream=new ReadableStream<Uint8Array>({async start(controller){await done;controller.enqueue(new TextEncoder().encode(JSON.stringify({messageId:'after-snapshot',text:'progress'})));controller.close();}});
 return POST(new Request(url(),{method:'POST',headers:{origin:'https://app.example'},body:stream,duplex:'half'} as RequestInit),ctx());
}
it('denies an in-flight POST when the session is revoked after snapshot acquisition',async()=>{
 const response=await sendWithChangeAfterSnapshot(async()=>{fixtureSession.viewer=null;});
 expect(response.status).toBe(401);expect(await count()).toBe(0);
});
it('denies an in-flight POST when the current operator grant is removed after snapshot acquisition',async()=>{
 fixtureSession.viewer={id:'operator',isOperator:true};
 const response=await sendWithChangeAfterSnapshot(async()=>{fixtureSession.viewer={id:'operator',isOperator:false};});
 expect(response.status).toBe(404);expect(await count()).toBe(0);
});
it('rechecks ownership before an in-flight send and refuses to append after transfer',async()=>{
 const response=await sendWithChangeAfterSnapshot(async()=>{await fixtureDatabase.db.query('UPDATE jobs SET customer_id=$1 WHERE id=$2',['other',job]);});
 expect(response.status).toBe(404);expect(await count()).toBe(0);
});
it('refuses to return an in-flight reply containing a credential rotated after snapshot acquisition',async()=>{
 const response=await sendWithChangeAfterSnapshot(async()=>{await fixtureDatabase.db.query('INSERT INTO job_credentials VALUES($1,$2)',[job,encryptJson({token:'running'})]);});
 expect(response.status).toBe(503);expect(await response.text()).not.toContain('running');expect(await count()).toBe(0);
});
