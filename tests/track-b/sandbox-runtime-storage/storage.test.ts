import {it,expect} from 'vitest';
import {connection,storage,snapshots,binding,policy,publishActual,scenario,scope} from './helpers';
import {ROW_DIFF_SQL,gradeSandbox} from '../../../packages/core/src/evals/sandbox/grading';
import {runtimeBridgeDigest} from '../../../packages/core/src/evals/sandbox/runtime-bridge';
import type {StoredSnapshot} from '../../../packages/core/src/evals/sandbox/runtime-storage/store';
import type {AgentTransactionalSql} from '../../../packages/core/src/agents/postgres-ports';

it('recovers independent real SQL after native database restart with all hidden rows and original identity',async()=>{
 const c=connection();try{
  const adapter=snapshots(storage(c.db)),b=binding('native-restart'),s=await adapter.recover(b);expect(s).not.toBeNull();
  try{
   expect(s!.run.runId).toBe(b.runId);expect(await s!.run.query('SELECT id,value FROM hidden.entries ORDER BY id')).toEqual(Array.from({length:8},(_,i)=>({id:i+1,value:'approved'})));
   expect(await s!.run.query(ROW_DIFF_SQL)).toHaveLength(8);
   const grade=await gradeSandbox({...s!.evidence,run:s!.run,scenario,versions:b.versions,transcript:[]});expect(grade.checks.find(c=>c.id==='collateral')?.verdict).toBe('pass');
   for(const sql of ['UPDATE hidden.entries SET value=\'evil\'','WITH d AS (DELETE FROM hidden.entries RETURNING *) SELECT * FROM d','SELECT 1; DELETE FROM hidden.entries'])await expect(s!.run.query(sql)).rejects.toThrow();
   expect(await s!.run.query('SELECT $1::text AS value',["x'; DELETE FROM hidden.entries; --"])).toEqual([{value:"x'; DELETE FROM hidden.entries; --"}]);
  }finally{await s!.release();}
  await s!.release();await expect(s!.run.query('SELECT 1')).rejects.toThrow();
 }finally{await c.close();}
});
it('atomic concurrent identical publication uses independent SQL connections and survives an unknown commit acknowledgement',async()=>{
 const a=connection(),b=connection();try{
  expect((await a.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe((await b.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const sa=storage(a.db),sb=storage(b.db);await publishActual(sa,'concurrent');const entry=(await sa.get(binding('concurrent')))!;
  await Promise.all(Array.from({length:6},(_,i)=>(i%2?sa:sb).put(entry.record,entry.bytes)));
  let lost=true;const uncertain:AgentTransactionalSql={query:(sql,params)=>a.db.query(sql,params),transaction:async fn=>{const value=await a.db.transaction(fn);if(lost){lost=false;throw new Error('unknown_commit_ack');}return value;}};
  const uncertainStore=storage(uncertain),newBinding=binding('unknown-ack-new');const newRecord:StoredSnapshot={...entry.record,binding:newBinding,policy:policy(newBinding),snapshotId:runtimeBridgeDigest({request:newBinding,image:entry.record.imageDigest,diff:entry.record.diff,calls:entry.record.toolCalls,outbox:entry.record.outbox})};
  await expect(uncertainStore.put(newRecord,entry.bytes)).rejects.toThrow('unknown_commit_ack');expect((await sb.get(newBinding))!.record).toEqual(newRecord);const recovered=await snapshots(sb).recover(newBinding);expect(recovered!.run.runId).toBe(newBinding.runId);await recovered!.release();await uncertainStore.put(newRecord,entry.bytes);
  expect((await sb.get(binding('concurrent')))!.record).toEqual(entry.record);
  await expect(sa.put({...entry.record,imageSize:entry.record.imageSize+1},entry.bytes)).rejects.toThrow();
  const corrupted=entry.bytes.slice();corrupted[100]^=1;await expect(sa.put(entry.record,corrupted)).rejects.toThrow();
  await expect(sa.get({...binding('concurrent'),worldId:'foreign-world'})).rejects.toThrow();
  await expect(sa.get({...binding('concurrent'),versions:{...binding('concurrent').versions,runtime:'another-runtime'}})).rejects.toThrow();
  expect(await storage(a.db,{scope:{tenantId:'other',jobId:'other',environmentId:'other'}}).get(binding('concurrent'))).toBeNull();
 }finally{await a.close();await b.close();}
});
it('current authorization gates publication, recovery and every query after recovery',async()=>{
 const c=connection();try{
  let authorized=true;const s=storage(c.db,{authorize:async()=>authorized});await publishActual(s,'revocation');const adapter=snapshots(s,{synchronousReadGuard:()=>authorized}),snap=await adapter.recover(binding('revocation'));expect(snap).not.toBeNull();
  try{authorized=false;expect(()=>snap!.run.trajectory()).toThrow();await expect(snap!.run.query('SELECT 1')).rejects.toThrow();await expect(adapter.recover(binding('revocation'))).rejects.toThrow();await expect(s.get(binding('revocation'))).rejects.toThrow();await expect(s.reap(Date.now())).rejects.toThrow();}finally{await snap!.release();}
 }finally{await c.close();}
});
it('fresh secret policy screens actual retained SQL and query output after rotation',async()=>{
 const c=connection();try{
  let secrets:string[]=[];const s=storage(c.db,{knownSecrets:()=>secrets});await publishActual(s,'secrets');const adapter=snapshots(s),snap=await adapter.recover(binding('secrets'));expect(snap).not.toBeNull();
  try{secrets=['approved'];await expect(snap!.run.query('SELECT value FROM hidden.entries')).rejects.toThrow();await expect(adapter.recover(binding('secrets'))).rejects.toThrow();}finally{await snap!.release();}
 }finally{await c.close();}
});
it('preissued policy cannot be replaced by a postexecution grant and missing authority stays absent',async()=>{
 const c=connection();try{
  const s=storage(c.db);await publishActual(s,'authority');const b=binding('authority');
  await expect(snapshots(s,{resolvePolicy:async()=>({...policy(b),allowed:[]})}).recover(b)).rejects.toThrow();
  await expect(snapshots(s,{resolvePolicy:async()=>policy({...b,worldId:'foreign'})}).prepare(b)).rejects.toThrow();
  const empty=snapshots(s,{resolvePolicy:async()=>null});const missing=await empty.prepare(binding('absent-policy'));expect(missing).toBeDefined();
 }finally{await c.close();}
});
it('needed images survive reaping; explicit release honors retained deadline and open snapshots survive deletion',async()=>{
 const c=connection();try{
  const s=storage(c.db),b=binding('retention');await publishActual(s,b.runId);expect(await s.reap(Date.now()+100000)).toBe(0);
  const until=Date.now()+60000;await s.retain(b,until);await s.retain(b,until-1000);await s.releaseRetention(b);
  expect(await s.reap(until-1)).toBe(0);const snap=await snapshots(s).recover(b);expect(snap).not.toBeNull();
  expect(await s.reap(until+1)).toBe(1);
  try{expect(await snap!.run.query('SELECT count(*)::int AS n FROM hidden.entries')).toEqual([{n:8}]);}finally{await snap!.release();}
  await expect(s.get(b)).rejects.toThrow();
  // Tombstone must forbid a changed or retry publication after deletion.
  await expect(publishActual(s,b.runId)).rejects.toThrow();
 }finally{await c.close();}
});
it('bounds image and metadata sizes before durable publication',async()=>{
 const c=connection();try{
  const s=storage(c.db);await publishActual(s,'bounded');const entry=(await s.get(binding('bounded')))!;
  await expect(storage(c.db,{maxImageBytes:32}).put(entry.record,entry.bytes)).rejects.toThrow();
  await expect(storage(c.db,{maxMetadataBytes:32}).put(entry.record,entry.bytes)).rejects.toThrow();
 }finally{await c.close();}
});
it('concurrent retention and scoped reaping on independent connections never deletes a protected image',async()=>{
 const a=connection(),b=connection();try{
  const sa=storage(a.db),sb=storage(b.db),key=binding('retain-race');await publishActual(sa,key.runId);const future=Date.now()+60000;await sa.retain(key,future);await sa.releaseRetention(key);
  await Promise.all([sa.retain(key,future+1000),sb.reap(Date.now())]);expect(await sb.get(key)).not.toBeNull();
 }finally{await a.close();await b.close();}
});
it('rotation during asynchronous binary screening must reject before SQL access',async()=>{
 const c=connection();try{
  const base=storage(c.db);await publishActual(base,'secret-rotation');let secrets:string[]=[],flip=false;
  const guarded=storage(c.db,{knownSecrets:()=>secrets,screenImage:async(_bytes,known)=>{if(flip){secrets=['approved'];flip=false;await Promise.resolve();}if(known.includes('approved'))throw new Error('rotated_secret');}});
  flip=true;await expect(guarded.get(binding('secret-rotation'))).rejects.toThrow();
 }finally{await c.close();}
});
it('recovery rejects a full diff above its configured row bound instead of attesting a sample',async()=>{
 const c=connection();try{await expect(snapshots(storage(c.db),{maxRows:4}).recover(binding('native-restart'))).rejects.toThrow();}finally{await c.close();}
});
it('secret rotation in final authorization callback still blocks returning already executed SQL output',async()=>{
 const c=connection();try{
  const base=storage(c.db);await publishActual(base,'query-final-auth');let secrets:string[]=[],armed=false,reads=0;
  const guarded=storage(c.db,{knownSecrets:()=>secrets,authorize:async({operation})=>{if(armed&&operation==='read'&&++reads===2)secrets=['approved'];return true;}});
  const snap=await snapshots(guarded).recover(binding('query-final-auth'));expect(snap).not.toBeNull();armed=true;
  try{await expect(snap!.run.query('SELECT value FROM hidden.entries')).rejects.toThrow();expect(reads).toBeGreaterThanOrEqual(2);}finally{await snap!.release();}
 }finally{await c.close();}
});
it('actual absent preissued authority remains unknown after durable recovery despite a true SQL goal',async()=>{
 const c=connection();try{
  const s=storage(c.db);await publishActual(s,'no-authority',{resolvePolicy:async()=>null});const b=binding('no-authority'),snap=await snapshots(s,{resolvePolicy:async()=>null}).recover(b);expect(snap).not.toBeNull();
  try{expect(snap!.evidence.rowAuthority).toBeUndefined();const grade=await gradeSandbox({...snap!.evidence,run:snap!.run,scenario,versions:b.versions,transcript:[]});expect(grade.checks.find(c=>c.id==='collateral')?.verdict).toBe('unknown');}finally{await snap!.release();}
 }finally{await c.close();}
});
it('rotation in final publication authorization blocks metadata-only credentials absent from SQL image',async()=>{
 const c=connection();try{
  const base=storage(c.db),entry=(await base.get(binding('native-restart')))!,b=binding('metadata-only-secret'),secret='metadata-only-retired-credential';
  const calls=[{seq:0,tool:'lookup',args:{},result:secret,ms:0}],record:StoredSnapshot={...entry.record,binding:b,policy:policy(b),toolCalls:calls,snapshotId:runtimeBridgeDigest({request:b,image:entry.record.imageDigest,diff:entry.record.diff,calls,outbox:entry.record.outbox})};
  let secrets:string[]=[],reviews=0,auths=0;const guarded=storage(c.db,{knownSecrets:()=>secrets,screenImage:async()=>{reviews++;},authorize:async()=>{auths++;if(reviews>=2)secrets=[secret];return true;}});
  await expect(guarded.put(record,entry.bytes)).rejects.toThrow();expect(auths).toBeGreaterThan(1);
 }finally{await c.close();}
});
it('tampered durable byte and metadata bindings fail independently of caller validation',async()=>{
 const c=connection();try{
  const s=storage(c.db),published=await publishActual(s,'tampered-row'),b=published.binding,key=runtimeBridgeDigest(scope);
  await c.pool.query('UPDATE sandbox_runtime_storage.images SET image_digest=$3 WHERE scope_key=$1 AND run_id=$2',[key,b.runId,'0'.repeat(64)]);
  await expect(snapshots(s).recover(b)).rejects.toThrow();
  await c.pool.query("UPDATE sandbox_runtime_storage.images SET image_digest=$3,metadata=jsonb_set(metadata,'{outbox}',$4::jsonb) WHERE scope_key=$1 AND run_id=$2",[key,b.runId,published.record.imageDigest,JSON.stringify([{tampered:true}])]);
  await expect(s.get(b)).rejects.toThrow();
 }finally{await c.close();}
});
it('receipt extras cannot override independently preissued binding or policy and reject before capture',async()=>{
 const c=connection();try{
  const prepared=await snapshots(storage(c.db)).prepare(binding('receipt-override'));let dumps=0;
  const source={dumpDataDir:async()=>{dumps++;throw new Error('must_not_capture');}};
  for(const extra of [{policy:null},{binding:binding('foreign-run')},{imageDigest:'0'.repeat(64)},{snapshotId:'forged'}]){
   const receipts={diff:[],toolCalls:[],outbox:[],...extra};expect(()=>prepared.publish(source,receipts)).toThrow();
  }
  expect(dumps).toBe(0);
 }finally{await c.close();}
});
