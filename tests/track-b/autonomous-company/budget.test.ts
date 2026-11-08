import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {it,expect} from 'vitest';
import {createAutonomousBudgetLedger} from '../../../packages/core/src/agents/autonomy/budget';
import {createAutonomousPolicy,DEFAULT_AUTONOMY_CAPS} from '../../../packages/core/src/agents/autonomy/policy';
import {PostgresBudgetLedger,type AgentTransactionalSql} from '../../../packages/core/src/agents/postgres-ports';
it('enforces configured lower role and aggregate root authority in the same SQL reservation',async()=>{
 const sql=new PGlite();try{
 await sql.exec(readFileSync(new URL('../../../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',import.meta.url),'utf8'));
 const db:AgentTransactionalSql={query:(s,p)=>sql.query(s,p),transaction:fn=>sql.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
 const policy=createAutonomousPolicy({schema:'autonomous-company-policy/v1',version:'v1',tenantId:'tenant',periodId:'p',enabled:true,rootBudgetMicroUsd:200,...DEFAULT_AUTONOMY_CAPS,singleJobCapMicroUsd:100,comparisonJobCapMicroUsd:100,roleCapsMicroUsd:{commercial:50,evaluation_engineer:50,quality_investigator:50,company_operator:50},agents:{commercial:{id:'c',version:1},evaluation_engineer:{id:'e',version:1},quality_investigator:{id:'q',version:1},company_operator:{id:'o',version:1}},allowedActions:['agent_task'],leaseMs:10,actionDeadlineMs:100,maxRecoveryChecks:2});
 const ledger=createAutonomousBudgetLedger(new PostgresBudgetLedger(db),policy);
 const reserve=(id:string,role='commercial')=>ledger.reserve({reservationId:id,jobId:id,amountMicroUsd:30,scopes:[{key:`job:${id}`,capMicroUsd:100},{key:`agent:${role}:p`,capMicroUsd:1000000}]});
 const result=await Promise.all([reserve('a'),reserve('b')]);expect(result.filter(r=>r.ok)).toHaveLength(1);
 await ledger.settle('a',45);expect((await reserve('c')).ok).toBe(false);
 }finally{await sql.close();}
});
