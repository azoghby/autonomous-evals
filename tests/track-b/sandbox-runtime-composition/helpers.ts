import {gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import type {AgentTransactionalSql,AgentSqlExecutor} from '../../../packages/core/src/agents/postgres-ports';
import {createPostgresRuntimeStorage} from '../../../packages/core/src/evals/sandbox/runtime-storage/postgres';
import {createDurableRuntimeSnapshots} from '../../../packages/core/src/evals/sandbox/runtime-storage/recovery';
import {runtimeBridgeDigest,type PolicyRequest,type ExactRowPolicy} from '../../../packages/core/src/evals/sandbox/runtime-bridge';
import {createSandboxRun} from '../../../packages/core/src/sandbox/runtime/run';
import {WORLD_PREAMBLE_SQL,snapshotBaseline} from '../../../packages/core/src/sandbox/runtime/world-sql';
import {tinyEnv,tinyScenario} from '../../../packages/core/src/sandbox/runtime/__fixtures__/tiny-env';
import type {SqlConn} from '../../../packages/core/src/sandbox/runtime/types';
import type {RowMutation} from '../../../packages/core/src/evals/sandbox/grading';
const require=createRequire(`${process.env.SANDBOX_STORAGE_RUNTIME}/package.json`);
const {Pool}=require('pg');
export const scope={tenantId:'storage-tenant',jobId:'storage-job',environmentId:'storage-env'};
export function connection(){
 const pool=new Pool({...JSON.parse(process.env.SANDBOX_STORAGE_CONFIG!),max:4});
 const db:AgentTransactionalSql={query:(sql,params)=>pool.query(sql,params),transaction:async fn=>{
  const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');const result=await fn({query:(sql,params)=>c.query(sql,params)} as AgentSqlExecutor);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }};
 return {db,pool,close:()=>pool.end()};
}
export function storage(db:AgentTransactionalSql,overrides:Partial<Parameters<typeof createPostgresRuntimeStorage>[0]>={}){
 return createPostgresRuntimeStorage({db,scope,authorize:async()=>true,knownSecrets:()=>[],screenImage:async(bytes,secrets)=>{if(!secrets.length)return;const expanded=bytes[0]===31&&bytes[1]===139?gunzipSync(bytes):Buffer.from(bytes);if(secrets.some(secret=>expanded.includes(Buffer.from(secret))))throw new Error('fixture_image_secret');},...overrides});
}
export const environment=tinyEnv({state:{ddl:'CREATE SCHEMA hidden; CREATE TABLE hidden.entries(id integer PRIMARY KEY, value text NOT NULL)',seedSql:"INSERT INTO hidden.entries SELECT g, 'before' FROM generate_series(1,8) g",frozenNow:'2026-06-01T00:00:00Z',reportTables:[]}});
export const scenario=tinyScenario({allowedWriteTables:['hidden.entries'],stateAssertions:[{id:'goal',sql:'SELECT true AS ok',severity:'high',description:'Not a permission grant'}]});
export function binding(runId:string):PolicyRequest {
 const versions={spec:'sandbox-spec-v1' as const,envHash:runtimeBridgeDigest(environment),suiteHash:'reviewed-suite',runtime:'actual-runtime',simulatorModel:'offline',judgeModel:'offline'};
 return {runId,worldId:`world:${runId}`,executionIdentity:`execution:${runId}`,scenarioHash:runtimeBridgeDigest(scenario),envHash:versions.envHash,suiteHash:versions.suiteHash,versions};
}
// Independently reviewed fixture policy exists before any mutation or diff is observed.
const allowed:RowMutation[]=Array.from({length:8},(_,i)=>({table_name:'hidden.entries',pk:{id:i+1},change:'updated',before:{id:i+1,value:'before'},after:{id:i+1,value:'approved'}}));
export function policy(b:PolicyRequest):ExactRowPolicy {return {...structuredClone(b),policyId:'preissued-reviewed-policy',allowed:structuredClone(allowed)};}
export function snapshots(s:ReturnType<typeof storage>,overrides:Partial<Parameters<typeof createDurableRuntimeSnapshots>[0]>={}){
 return createDurableRuntimeSnapshots({storage:s,resolvePolicy:async b=>policy(b),synchronousReadGuard:()=>true,...overrides});
}
export async function publishActual(s:ReturnType<typeof storage>,runId:string,overrides:Partial<Parameters<typeof createDurableRuntimeSnapshots>[0]>={}){
 const b=binding(runId),adapter=snapshots(s,overrides),prepared=await adapter.prepare(b);
 const db=new PGlite();const conn:SqlConn={query:async(sql,params=[])=>{const r=await db.query(sql,params);return {rows:r.rows as never[],rowCount:r.affectedRows??r.rows.length};},exec:async sql=>{await db.exec(sql);},close:()=>db.close()};
 await db.exec(WORLD_PREAMBLE_SQL);await db.exec(environment.state.ddl);await db.exec(environment.state.seedSql);await snapshotBaseline(conn);
 const raw=createSandboxRun({runId,conn,env:environment,scenario});
 try{
  await db.exec("UPDATE hidden.entries SET value='approved'");
  const diff=await raw.diff(),receipts={diff,toolCalls:raw.trajectory(),outbox:await raw.outbox()};
  const record=await prepared.publish(db,receipts);
  return {record,binding:b,receipts};
 }finally{await raw.dispose();}
}
