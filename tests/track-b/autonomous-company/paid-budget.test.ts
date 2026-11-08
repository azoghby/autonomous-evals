import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {it,expect} from 'vitest';
import {createAutonomousBudgetLedger,createAutonomousPaidReservationPolicy} from '../../../packages/core/src/agents/autonomy/budget';
import {createAutonomousPolicy,type AutonomyRole} from '../../../packages/core/src/agents/autonomy/policy';
import {PostgresBudgetLedger,type AgentTransactionalSql} from '../../../packages/core/src/agents/postgres-ports';
import {PostgresRemediationAccounting} from '../../../packages/core/src/evals/remediation/accounting';
import type {JobRef} from '../../../packages/core/src/evals/types';

const policy=()=>createAutonomousPolicy({schema:'autonomous-company-policy/v1',version:'v1',tenantId:'tenant',periodId:'period',enabled:true,rootBudgetMicroUsd:200,singleJobCapMicroUsd:100,comparisonJobCapMicroUsd:100,roleCapsMicroUsd:{commercial:50,evaluation_engineer:50,quality_investigator:50,company_operator:50},agents:{commercial:{id:'c',version:1},evaluation_engineer:{id:'e',version:1},quality_investigator:{id:'q',version:1},company_operator:{id:'o',version:1}},allowedActions:['agent_task'],leaseMs:10,actionDeadlineMs:100,maxRecoveryChecks:2});
const job:JobRef={jobId:'mixed-job',customerId:'tenant',package:'workflow_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null};
const settings=()=>({policy:policy(),job,role:'evaluation_engineer' as const,jobCapMicroUsd:100,reservationMicroUsd:30});
const session=(id:string)=>({reservationId:id,jobId:job.jobId,amountMicroUsd:30,scopes:[{key:`job:${job.jobId}`,capMicroUsd:100},{key:'agent:evaluation_engineer:period',capMicroUsd:65_000_000}]});
async function database(){
 const engine=new PGlite();
 await engine.exec(readFileSync(new URL('../../../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',import.meta.url),'utf8'));
 await engine.exec(readFileSync(new URL('../../../packages/core/src/evals/remediation/accounting/001-remediation-accounting.sql',import.meta.url),'utf8'));
 const sql:AgentTransactionalSql={query:(s,p)=>engine.query(s,p),transaction:fn=>engine.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
 return {engine,sql};
}
it('Naive and target reservations share one SQL role/root/job budget across fresh adapters',async()=>{
 const {engine,sql}=await database();try{
  const ledger=createAutonomousBudgetLedger(new PostgresBudgetLedger(sql),policy());
  expect((await ledger.reserve(session('naive-session'))).ok).toBe(true);
  const reservation=createAutonomousPaidReservationPolicy(settings());
  const make=()=>new PostgresRemediationAccounting({sql,jobId:job.jobId,reservation,deliverCost:async()=>{throw Error('no priced receipt in this test');}});
  const operation={operationId:'target-call',inputDigest:'a'.repeat(64),kind:'target' as const};
  expect(await make().authorize(operation)).toBe(false); // 30 + 30 exceeds the shared 50 role cap.
  await ledger.settle('naive-session',10);
  expect(await make().authorize(operation)).toBe(false); // Denied identity stays denied, never resets.
  expect(await make().authorize({...operation,operationId:'target-after-settlement'})).toBe(true);
  const rows=(await engine.query<{scopes:Array<{key:string}>;settled_micro_usd:number|null}>('SELECT scopes,settled_micro_usd FROM agent_persistence.reservations WHERE id=$1',['target-after-settlement'])).rows;
  expect(rows[0].scopes.filter(s=>s.key.startsWith('autonomous-root:'))).toEqual([{key:'autonomous-root:tenant:period',capMicroUsd:200}]);
  expect(rows[0].settled_micro_usd).toBeNull();
  expect((await ledger.reserve(session('naive-after-target'))).ok).toBe(false); // Unknown target spend retains its 30 hold.
  expect((await engine.query('SELECT * FROM agent_persistence.reservations')).rows).toHaveLength(4);
 }finally{await engine.close();}
});
it('mixed paid and agent requests cannot exceed their common job cap across roles',async()=>{
 const {engine,sql}=await database();try{
  const ledger=createAutonomousBudgetLedger(new PostgresBudgetLedger(sql),policy());
  const requests=['commercial','evaluation_engineer','quality_investigator','company_operator'].map((role,index)=>createAutonomousPaidReservationPolicy({...settings(),role:role as AutonomyRole})({operationId:`op-${index}`}));
  const outcomes=await Promise.all(requests.map(r=>new PostgresBudgetLedger(sql).reserve(r)));
  expect(outcomes.filter(r=>r.ok)).toHaveLength(3);
  const denied=outcomes.find(r=>!r.ok);expect(denied).toMatchObject({ok:false,exhaustedScope:'job:mixed-job'});
  expect((await ledger.reserve({...session('extra'),amountMicroUsd:11})).ok).toBe(false);
 }finally{await engine.close();}
});
it('rejects mismatched periods, duplicate root scopes and multiple role scopes before forwarding',async()=>{
 let forwarded=0;
 const ledger=createAutonomousBudgetLedger({reserve:async()=>{forwarded++;throw Error('unexpected');},settle:async()=>({settledMicroUsd:0,replayed:false})},policy());
 const wrong=session('wrong');wrong.scopes[1].key='agent:evaluation_engineer:other-period';
 await expect(ledger.reserve(wrong)).rejects.toThrow('scope_required');
 const root=session('root');root.scopes.push({key:'autonomous-root:tenant:period',capMicroUsd:200});
 await expect(ledger.reserve(root)).rejects.toThrow('scope_required');
 const roles=session('roles');roles.scopes.push({key:'agent:commercial:period',capMicroUsd:50});
 await expect(ledger.reserve(roles)).rejects.toThrow('scope_required');expect(forwarded).toBe(0);
});
it('pins authorized holds and rejects foreign jobs, invalid periods, and cap increases',()=>{
 expect(()=>createAutonomousPaidReservationPolicy({...settings(),job:{...job,customerId:'other'}})).toThrow('policy_invalid');
 expect(()=>createAutonomousPaidReservationPolicy({...settings(),policy:{...policy(),periodId:'invalid:period'}})).toThrow('policy_invalid');
 expect(()=>createAutonomousPaidReservationPolicy({...settings(),jobCapMicroUsd:101})).toThrow('policy_invalid');
 expect(()=>createAutonomousPaidReservationPolicy({...settings(),reservationMicroUsd:0})).toThrow('policy_invalid');
 const input=settings(),factory=createAutonomousPaidReservationPolicy(input);
 input.jobCapMicroUsd=999;input.reservationMicroUsd=999;
 const first=factory({operationId:'held'});expect(first.amountMicroUsd).toBe(30);
 first.scopes[0].capMicroUsd=999;
 expect(factory({operationId:'held'}).scopes[0].capMicroUsd).toBe(100);
 expect(()=>factory({operationId:'bad\0id'})).toThrow('operation_invalid');
});
