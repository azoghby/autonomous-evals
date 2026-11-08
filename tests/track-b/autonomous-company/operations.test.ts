import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createAutonomousPolicy, DEFAULT_AUTONOMY_CAPS, autonomyDigest, type AutonomousPolicy } from '../../../packages/core/src/agents/autonomy/policy';
import { PostgresAutonomySupervisor, type AutonomyActionInput } from '../../../packages/core/src/agents/autonomy/supervisor';
import type { AgentTransactionalSql, AgentSqlExecutor } from '../../../packages/core/src/agents/postgres-ports';

const opened:PGlite[]=[];
afterEach(async()=>{await Promise.all(opened.splice(0).map(db=>db.close()));});
function policy():AutonomousPolicy {return createAutonomousPolicy({schema:'autonomous-company-policy/v1',version:'v1',tenantId:'tenant',periodId:'hackathon',enabled:true,
 rootBudgetMicroUsd:250_000_000,...DEFAULT_AUTONOMY_CAPS, agents:{commercial:{id:'commercial',version:2},evaluation_engineer:{id:'engineer',version:2},quality_investigator:{id:'investigator',version:2},company_operator:{id:'operator',version:2}},
 allowedActions:['qualify','design','report'],leaseMs:10,actionDeadlineMs:100,maxRecoveryChecks:2});}
const request=(key='job:qualify',amount=100):AutonomyActionInput=>({tenantId:'tenant',key,jobId:'job',comparison:false,role:'commercial',agentId:'commercial',agentVersion:2,kind:'qualify',inputDigest:autonomyDigest({intake:'hello'}),reserveMicroUsd:amount});
async function setup(p=policy()) {
 const db=new PGlite();opened.push(db);await db.exec(readFileSync(new URL('../../../packages/core/src/agents/autonomy/operations.sql',import.meta.url),'utf8'));
 // PGlite is one embedded SQL connection. Serialize transactions, preserving true rollback and SQL constraints.
 let tail=Promise.resolve();
 const adapter:AgentTransactionalSql={query:async<T>(sql:string,params?:unknown[])=>{const r=await db.query<T>(sql,params);return {rows:r.rows};},
 transaction:async<T>(fn:(tx:AgentSqlExecutor)=>Promise<T>)=>{ const previous=tail;let release!:()=>void;tail=new Promise<void>(r=>{release=r;});await previous;try{return await db.transaction(tx=>fn({query:async<R>(sql:string,params?:unknown[])=>({rows:(await tx.query<R>(sql,params)).rows})}));}finally{release();}}};
 return {db,adapter,supervisor:new PostgresAutonomySupervisor(adapter,p,async(tenant,job)=>tenant==='tenant'&&job==='job')};
}
describe('durable autonomous operating authority',()=>{
 it('pins policy and exact agent identity, refuses injected authority and cross-user access',async()=>{
  const {supervisor:s,adapter}=await setup();
  expect(await s.begin({...request(),agentVersion:3},'worker',0)).toEqual({status:'denied',reason:'action_or_exact_agent_not_authorized'});
  await expect(s.begin({...request(),tenantId:'other'},'worker',0)).rejects.toThrow('unauthorized');
  expect(await s.begin({...request(),kind:'raise_budget'},'worker',0)).toMatchObject({status:'denied'});
  expect((await s.authorizeDecision(request(),0)).allowed).toBe(true);
  const changed=new PostgresAutonomySupervisor(adapter,{...policy(),leaseMs:11},async()=>true);
  await expect(changed.begin(request(),'worker',0)).rejects.toThrow('policy_version_conflict');
 });
 it('restarts and concurrently reserves once; receipt replay never adds spending',async()=>{
  const {supervisor:s,adapter,db}=await setup();
  const both=await Promise.all([s.begin(request(),'worker1',0),s.begin(request(),'worker2',0)]);
  expect(both.map(r=>r.status).sort()).toEqual(['acquired','existing']);
  const restarted=new PostgresAutonomySupervisor(adapter,policy(),async()=>true);
  expect((await restarted.begin(request(),'worker3',11)).status).toBe('acquired');
  await restarted.markDispatched(request().key,'worker3',12);
  const receipt={providerId:'session1',resultDigest:autonomyDigest({ok:true}),costMicroUsd:40};
  await restarted.complete(request().key,'worker3',receipt,13);
  await restarted.complete(request().key,'worker3',receipt,14);
  expect((await db.query<{held:number}>('SELECT held FROM company_autonomy.actions')).rows.map(r=>Number(r.held))).toEqual([40]);
  await expect(restarted.begin({...request(),inputDigest:autonomyDigest('changed')},'worker',15)).rejects.toThrow('identity_conflict');
 });
 it('enforces aggregate job and role budgets, retaining unknown cost',async()=>{
  const {supervisor:s}=await setup();
  expect((await s.begin(request('one',2_000_000),'worker',0)).status).toBe('acquired');
  expect(await s.begin(request('two',2_000_000),'worker',0)).toEqual({status:'denied',reason:'budget_exhausted'});
  await s.markDispatched('one','worker',1);
  await s.complete('one','worker',{providerId:'paid1',resultDigest:autonomyDigest('result'),costMicroUsd:null},2);
  expect(await s.begin(request('two',2_000_000),'worker',3)).toMatchObject({status:'denied'});
  const p=policy();const small=createAutonomousPolicy({...p,roleCapsMicroUsd:{...p.roleCapsMicroUsd,commercial:10}});
  const {supervisor:limited}=await setup(small);
  expect(await limited.begin(request('tiny',11),'w',0)).toMatchObject({status:'denied',reason:'budget_exhausted'});
 });
 it('freezes per-job package authority and deduplicates decision timestamps',async()=>{
  const {supervisor:s,db}=await setup();
  await s.begin(request('first'),'worker',0);
  await expect(s.begin({...request('second'),comparison:true},'worker',1)).rejects.toThrow('job_budget_immutable');
  await s.authorizeDecision({...request('audit'),kind:'report'},1);
  await s.authorizeDecision({...request('audit'),kind:'report'},2);
  const rows=await db.query<{record:{key:string}}>('SELECT record FROM company_autonomy.decisions');
  expect(rows.rows.filter(r=>r.record.key==='audit')).toHaveLength(1);
  await s.dailyAudit('1970-01-01');await s.dailyAudit('1970-01-01');
  expect((await db.query('SELECT * FROM company_autonomy.daily_audits')).rows).toHaveLength(1);
 });
 it('queries ambiguous paid receipts without redispatch and accounts for measured overage',async()=>{
  const {supervisor:s}=await setup();await s.begin(request(),'worker',0);await s.markDispatched(request().key,'worker',1);
  let queries=0;
  const recovered=await s.recoverDue(11,async a=>{queries++;expect(a.key).toBe(request().key);return {status:'found',receipt:{providerId:'paid1',resultDigest:autonomyDigest('done'),costMicroUsd:4_000_000}};});
  expect(recovered[0].state).toBe('completed');expect(queries).toBe(1);
  expect(await s.begin(request('next',1),'worker',12)).toMatchObject({status:'denied'});
  expect(await s.recoverDue(22,async()=>{throw new Error('must not query complete');})).toEqual([]);
 });
 it('bounds an unresponsive authoritative receipt lookup without dispatch retry',async()=>{
  const {supervisor:s}=await setup();await s.begin(request(),'worker',0);await s.markDispatched(request().key,'worker',1);
  const result=await s.recoverDue(11,async()=>new Promise(()=>{}));
  expect(result[0]).toMatchObject({state:'inconclusive',reason:'ambiguous_dispatch_inconclusive',costStatus:'unknown'});
 });
 it('bounds receipt recovery, honestly closes ambiguity, and releases undispatched expiry only',async()=>{
  const {supervisor:s,db}=await setup();await s.begin(request('paid'),'worker',0);await s.markDispatched('paid','worker',1);
  expect((await s.recoverDue(11,async()=>({status:'pending'})))[0].state).toBe('dispatched');
  expect((await s.recoverDue(22,async()=>({status:'absent'})))[0]).toMatchObject({state:'inconclusive',reason:'ambiguous_dispatch_inconclusive',costStatus:'unknown'});
  expect((await s.begin(request('paid'),'new',1000)).status).toBe('existing');
  await s.begin(request('never-dispatched'),'worker',0);
  expect((await s.recoverDue(101,async()=>{throw new Error('unpaid needs no provider');}))[0].reason).toBe('undispatched_deadline_expired');
  const rows=(await db.query<{action_key:string;held:number}>('SELECT action_key,held FROM company_autonomy.actions ORDER BY action_key')).rows;
  expect(rows.map(r=>[r.action_key,Number(r.held)])).toEqual([['never-dispatched',0],['paid',100]]);
  expect((await s.dailyAudit('1970-01-01')).some(d=>d.reason==='ambiguous_dispatch_inconclusive'&&d.policyVersion==='v1')).toBe(true);
 });
});
