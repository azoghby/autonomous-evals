import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createSandboxRun } from '../../../packages/core/src/sandbox/runtime/run';
import { WORLD_PREAMBLE_SQL, clockSql, snapshotBaseline } from '../../../packages/core/src/sandbox/runtime/world-sql';
import { tinyEnv, tinyScenario, TINY_DDL, TINY_SEED } from '../../../packages/core/src/sandbox/runtime/__fixtures__/tiny-env';
import type { SqlConn } from '../../../packages/core/src/sandbox/runtime/types';
import type { EvalVersions } from '../../../packages/core/src/sandbox/spec';
import { retainRuntimeRun, capturePGliteImage, runtimeBridgeDigest, type ExactRowPolicy, type SnapshotArtifact } from '../../../packages/core/src/evals/sandbox/runtime-bridge';
import { gradeSandbox, ROW_DIFF_SQL, type RowMutation } from '../../../packages/core/src/evals/sandbox/grading';

const before = {id:'cus_1',name:"Ada O'Neil",email:'ada@example.test'};
const authorized:RowMutation = {table_name:'customers',pk:{id:'cus_1'},change:'updated',before,after:{...before,email:'approved@example.test'}};
async function fixture(mode: 'approved'|'absent'|'stale' = 'approved', maxRows = 5000, extraRows = false, openGate?: { entered(): void; wait: Promise<void> }, withExec = false) {
 const db = new PGlite();
 const conn:SqlConn = {query:async(sql,params=[])=>{const r=await db.query(sql,params);return {rows:r.rows as never[],rowCount:r.affectedRows??r.rows.length};},exec:async sql=>{await db.exec(sql);},close:()=>db.close()};
 await db.exec(WORLD_PREAMBLE_SQL);const clock=clockSql('2026-06-01T15:00:00Z');await conn.query(clock.text,clock.values);
 await db.exec(TINY_DDL);await db.exec(TINY_SEED);
 if(extraRows) await db.exec("INSERT INTO customers SELECT 'extra_'||g, 'Extra', 'old@example.test' FROM generate_series(1,8) g");
 await snapshotBaseline(conn);
 const env=tinyEnv();
 env.tools.push({name:'set_email',description:'edit',effect:'write',source:'test',inputSchema:{type:'object'},binding:{kind:'sql',statements:['UPDATE customers SET email=:email WHERE id=:id'],resultShape:'count'}},
 {name:'erase',description:'delete',effect:'write',source:'test',inputSchema:{type:'object'},binding:{kind:'sql',statements:['DELETE FROM orders WHERE id=:id'],resultShape:'count'}});
 env.tools.push({name:'bulk',description:'bulk edit',effect:'write',source:'test',inputSchema:{type:'object'},binding:{kind:'sql',statements:["UPDATE customers SET email='wrong' WHERE id LIKE 'extra_%'"],resultShape:'count'}});
 const scenario=tinyScenario({allowedWriteTables:['customers','orders'],stateAssertions:[{id:'goal',sql:'SELECT true AS ok',description:'Deliberately insufficient permission assertion',severity:'high'}]});
 const versions:EvalVersions={spec:'sandbox-spec-v1',envHash:runtimeBridgeDigest(env),suiteHash:'server-suite',runtime:'875ceef',simulatorModel:'offline',judgeModel:'offline'};
 const binding={worldId:'actual-world',executionIdentity:'actual-execution',environment:env,scenario,versions};
 const raw=createSandboxRun({runId:'actual-A-run',conn,env,scenario});
 if(withExec)Object.assign(raw,{exec:(sql:string)=>conn.exec(sql)});
 let policy:ExactRowPolicy|undefined;
 try {
 const bridge=await retainRuntimeRun({run:raw,binding,issuePolicy:async request=>{
   policy={...request,policyId:'reviewed-policy',allowed:[structuredClone(authorized)]};
   if(mode==='stale')policy.suiteHash='another-suite';
   return mode==='absent'?null:policy;
 },capture:async()=>{
   const image=await capturePGliteImage(db,maxRows);
   return openGate?{digest:image.digest,open:async()=>{openGate.entered();await openGate.wait;return image.open();}}:image;
 }});
 const artifact=async():Promise<SnapshotArtifact>=>({runId:raw.runId,worldId:binding.worldId,identityDigest:binding.executionIdentity,input:binding,diff:await bridge.run.diff(),toolCalls:bridge.run.trajectory(),outbox:await bridge.run.outbox()});
 return {db,bridge,binding,artifact,policy:()=>policy!};
 }catch(e){await raw.dispose();throw e;}
}
async function grade(f:Awaited<ReturnType<typeof fixture>>,artifact:SnapshotArtifact) {
 const s=await f.bridge.finalSnapshot(artifact);
 try{return await gradeSandbox({...s.evidence,run:s.run,scenario:f.binding.scenario,versions:f.binding.versions,transcript:[]});}
 finally{await s.release();}
}
for(const [name,id,email,tool,verdict] of [
 ['authorized update','cus_1','approved@example.test','set_email','pass'],
 ['wrong row','cus_2','approved@example.test','set_email','fail'],
 ['wrong value','cus_1','wrong@example.test','set_email','fail'],
 ['unauthorized deletion','ord_2','','erase','fail'],
] as const) it(`actual A SQL: ${name} collateral ${verdict}`,async()=>{
 const f=await fixture();
 try {
 await f.bridge.run.callTool(tool,{id,email});const artifact=await f.artifact();
 await f.bridge.run.dispose();
 const result=await grade(f,artifact);
 expect(result.checks.find(c=>c.id==='collateral')?.verdict).toBe(verdict);
 expect(result.verdict).toBe(verdict);
 }finally{await f.bridge.run.dispose();}
});
it('missing policy stays unknown despite boolean goal SQL',async()=>{
 const f=await fixture('absent');try{
 await f.bridge.run.callTool('set_email',{id:'cus_1',email:'approved@example.test'});const a=await f.artifact();await f.bridge.run.dispose();
 expect((await grade(f,a)).checks.find(c=>c.id==='collateral')?.verdict).toBe('unknown');
 }finally{await f.bridge.run.dispose();}
});
it('rejects stale server policy before returning an executable handle',async()=>{
 await expect(fixture('stale')).rejects.toThrow('snapshot_policy_binding_mismatch');
});
it('freezes policy, SQL image and identities; rejects altered artifact and released reads',async()=>{
 const f=await fixture();try{
 const pending=f.bridge.run.callTool('set_email',{id:'cus_1',email:'approved@example.test'});
 const dispose=f.bridge.run.dispose();
 await expect(f.bridge.run.callTool('set_email',{id:'cus_2',email:'wrong'})).rejects.toThrow('sealed');
 await pending;await dispose;
 // Sealed evidence is available through the exact gate lifecycle too.
 const s=await f.bridge.gateSnapshot();
 f.policy().allowed=[];
 expect(s.run.runId).toBe('actual-A-run');
 expect((await s.run.query(ROW_DIFF_SQL))).toHaveLength(1);
 expect((await gradeSandbox({...s.evidence,run:s.run,scenario:f.binding.scenario,versions:f.binding.versions,transcript:[]})).verdict).toBe('pass');
 const diff=await s.run.diff(), calls=s.run.trajectory();
 const a:SnapshotArtifact={runId:'actual-A-run',worldId:'actual-world',identityDigest:'actual-execution',input:f.binding,diff,toolCalls:calls,outbox:[]};
 for(const changed of [{runId:'renamed'},{worldId:'different'},{identityDigest:'different'},{input:{...f.binding,versions:{...f.binding.versions,suiteHash:'other'}}},{diff:[]},{toolCalls:[]}])
 await expect(f.bridge.finalSnapshot({...a,...changed})).rejects.toThrow('snapshot_execution_mismatch');
 await s.release();await s.release();await expect(s.run.query('SELECT true AS ok')).rejects.toThrow('released');
 const again=await f.bridge.finalSnapshot(a);expect(again.evidence.completeDiff.snapshotId).toBe(s.evidence.completeDiff.snapshotId);await again.release();
 }finally{await f.bridge.run.dispose();}
});
it('retained SQL enforces read-only, deadlines and bound parameters after live DB disposal',async()=>{
 const f=await fixture();try{
 expect(await f.bridge.run.query('SELECT $1::text AS value',['live-bound'])).toEqual([{value:'live-bound'}]);
 await f.bridge.run.dispose();const s=await f.bridge.gateSnapshot();try{
 expect(await s.run.query('SELECT $1::text AS value',["x'; DELETE FROM customers; --"])).toEqual([{value:"x'; DELETE FROM customers; --"}]);
 const p=[{v:'original'}];const read=s.run.query('SELECT $1::jsonb AS value',p);p[0].v='changed';expect(await read).toEqual([{value:{v:'original'}}]);
 for(const sql of ['DELETE FROM customers','WITH d AS (DELETE FROM customers RETURNING *) SELECT * FROM d','SELECT 1; DELETE FROM customers'])await expect(s.run.query(sql)).rejects.toThrow();
 await expect(s.run.query('SHOW statement_timeout')).rejects.toThrow();
 expect(await s.run.query("SELECT current_setting('statement_timeout') AS timeout")).toEqual([{timeout:'5s'}]);
 }finally{await s.release();}
 }finally{await f.bridge.run.dispose();}
});
it('capture failure still disposes raw run and never publishes a snapshot',async()=>{
 const f=await fixture();let disposed=0;
 const fake={...f.bridge.run,runId:'failure-run',dispose:async()=>{disposed++;await f.bridge.run.dispose();}};
 const b=await retainRuntimeRun({run:fake,binding:f.binding,issuePolicy:async()=>null,capture:async()=>{throw new Error('capture_failed');}});
 await expect(b.run.dispose()).rejects.toThrow('capture_failed');expect(disposed).toBe(1);
 await expect(b.gateSnapshot()).rejects.toThrow('capture_failed');await expect(b.run.dispose()).rejects.toThrow('capture_failed');expect(disposed).toBe(1);
});
it('refuses capped relation exports rather than issuing sampled completeness',async()=>{
 const f=await fixture('approved',1);try{
 await f.bridge.run.callTool('set_email',{id:'cus_1',email:'approved@example.test'});
 await f.bridge.run.callTool('set_email',{id:'cus_2',email:'wrong'});await f.bridge.run.dispose();
 await expect(f.bridge.gateSnapshot()).rejects.toThrow('snapshot_relation_unavailable');
 }finally{await f.bridge.run.dispose();}
});

it('full relation detects collateral beyond A five-row summary samples',async()=>{
 const f=await fixture('approved',5000,true);try{
 await f.bridge.run.callTool('bulk',{});
 const a=await f.artifact();expect(a.diff![0].updated).toBe(8);expect(a.diff![0].sample).toHaveLength(5);
 await f.bridge.run.dispose();const s=await f.bridge.finalSnapshot(a);try{
 expect(await s.run.query(ROW_DIFF_SQL)).toHaveLength(8);
 expect((await gradeSandbox({...s.evidence,run:s.run,scenario:f.binding.scenario,versions:f.binding.versions,transcript:[]})).checks.find(c=>c.id==='collateral')?.verdict).toBe('fail');
 }finally{await s.release();}
 }finally{await f.bridge.run.dispose();}
});
it('explicit retention cleanup refuses active leases and prevents new reads',async()=>{
 const f=await fixture();try{
 await expect(f.bridge.forget()).rejects.toThrow('not_disposed');
 await f.bridge.run.dispose();const s=await f.bridge.gateSnapshot();
 await expect(f.bridge.forget()).rejects.toThrow('leases_active');await s.release();
 await f.bridge.forget();await f.bridge.forget();await expect(f.bridge.gateSnapshot()).rejects.toThrow('forgotten');
 }finally{await f.bridge.run.dispose();}
});

it('returned tool records cannot rewrite authoritative trajectory',async()=>{
 const f=await fixture();try{
 const returned=await f.bridge.run.callTool('set_email',{id:'cus_1',email:'approved@example.test'});
 (returned.args as Record<string,unknown>).email='tampered';(returned.result as Record<string,unknown>).count=999;
 expect((f.bridge.run.trajectory()[0].args as Record<string,unknown>).email).toBe('approved@example.test');
 expect(f.bridge.run.trajectory()[0].result).toEqual({count:1});
 await f.bridge.run.dispose();const s=await f.bridge.gateSnapshot();try{
 expect(s.run.trajectory()[0].result).toEqual({count:1});
 }finally{await s.release();}
 }finally{await f.bridge.run.dispose();}
});
it('retention cleanup counts opening leases before asynchronous image recovery',async()=>{
 let enter!:()=>void, proceed!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;}), wait=new Promise<void>(resolve=>{proceed=resolve;});
 const f=await fixture('approved',5000,false,{entered:enter,wait});try{
 await f.bridge.run.dispose();const opening=f.bridge.gateSnapshot();await entered;
 await expect(f.bridge.forget()).rejects.toThrow('leases_active');proceed();
 const s=await opening;await s.release();await f.bridge.forget();
 }finally{proceed();await f.bridge.run.dispose();}
});
it('snapshots the supplied execution artifact before asynchronous sealing',async()=>{
 const f=await fixture();try{
  const artifact=await f.artifact();
  artifact.worldId='foreign-world';
  const pending=f.bridge.finalSnapshot(artifact);
  // A direct caller cannot swap an invalid identity for a valid one while sealing awaits SQL.
  artifact.worldId=f.binding.worldId;
  await expect(pending.then(async value=>{await value.release();return value;})).rejects.toThrow('snapshot_execution_mismatch');
 }finally{await f.bridge.run.dispose();}
});

it('trusted mutation exec drains before sealing and cannot mutate a retained snapshot',async()=>{
 const f=await fixture('absent',5000,false,undefined,true);
 try {
  expect(f.bridge.run.exec).toBeTypeOf('function');
  const pending=f.bridge.run.exec!("UPDATE customers SET email='trusted-mutation@example.test' WHERE id='cus_1'");
  const seal=f.bridge.seal();
  await expect(f.bridge.run.exec!("DELETE FROM customers")).rejects.toThrow('snapshot_run_sealed');
  await pending;await seal;
  const snapshot=await f.bridge.gateSnapshot();
  try {
   expect(await snapshot.run.query("SELECT email FROM customers WHERE id='cus_1'")).toEqual([{email:'trusted-mutation@example.test'}]);
   expect(snapshot.run.trajectory()).toEqual([]); // Trusted fixture mutation is not a target tool call.
   expect(await snapshot.run.query(ROW_DIFF_SQL)).toHaveLength(1);
  } finally {await snapshot.release();}
 } finally {await f.bridge.run.dispose();await f.bridge.forget();}
});
