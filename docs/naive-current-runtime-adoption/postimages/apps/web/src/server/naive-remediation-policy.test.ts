import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { loadNaiveRemediationTrialPolicy,mutateNaiveRemediationTrialPolicy,readNaiveRemediationPolicyStatus } from './naive-remediation-policy';
const jobId='123e4567-e89b-42d3-a456-426614174000',customerId='223e4567-e89b-42d3-a456-426614174000',operatorId='323e4567-e89b-42d3-a456-426614174000',targetVersion='a'.repeat(64);
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const dbs:PGlite[]=[];afterEach(async()=>{vi.unstubAllEnvs();for(const pg of dbs.splice(0))await pg.close();});
async function fixture(){
 vi.stubEnv('OPERATOR_EMAILS','operator@example.test');const pg=new PGlite();dbs.push(pg);
 for(const path of ['packages/core/src/db/migrations/0000_init.sql','packages/core/src/evals/integration/migrations/001-text-integration.sql'])await pg.exec(readFileSync(resolve(path),'utf8'));
 await pg.query(`INSERT INTO customers(id,email) VALUES($1,'customer@example.test'),($2,'operator@example.test')`,[customerId,operatorId]);
 const intake={package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.test/chat',model:'fixture',systemPrompt:'Original'}};
 await pg.query(`INSERT INTO jobs(id,customer_id,environment,package,is_mock,state,intake) VALUES($1,$2,'test','text_eval',false,'running',$3::jsonb)`,[jobId,customerId,JSON.stringify(intake)]);
 const binding={job:{jobId,customerId,environment:'test'},intakeDigest:digest(intake),targetVersion};
 await pg.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_method_binding','generic-text-v1',$2,'fixture','completed',$3::jsonb)`,[jobId,digest(binding),JSON.stringify(binding)]);
 const sql:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 const issue={action:'issue',targetVersion,kind:'stateless_chat_completions',isolation:'request_messages_only',declaresStateless:true,operationMicroUsd:100};
 return {pg,sql,issue,identity:{jobId,customerId,environment:'test' as const,targetVersion}};
}
describe('operator remediation trial policy SQL',()=>{
 it('issues exact immutable policy and replays without repeated audit',async()=>{
  const f=await fixture();expect(await loadNaiveRemediationTrialPolicy(f.sql,f.identity)).toBeNull();
  await mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,f.issue);await mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,f.issue);
  expect(await readNaiveRemediationPolicyStatus(f.sql,jobId,operatorId)).toMatchObject({status:'active',policy:{operationMicroUsd:100,issuedByOperator:operatorId}});
  expect((await f.pg.query('SELECT * FROM interventions')).rows).toHaveLength(1);
  await expect(mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,{...f.issue,operationMicroUsd:101})).rejects.toThrow();
 },60000);
 it('revokes irreversibly and denies resurrection',async()=>{
  const f=await fixture();await mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,f.issue);
  const revoke={action:'revoke',targetVersion};await mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,revoke);await mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,revoke);
  expect(await loadNaiveRemediationTrialPolicy(f.sql,f.identity)).toBeNull();expect(await readNaiveRemediationPolicyStatus(f.sql,jobId,operatorId)).toMatchObject({status:'revoked'});
  await expect(mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,f.issue)).rejects.toThrow();expect((await f.pg.query('SELECT * FROM interventions')).rows).toHaveLength(2);
 },60000);
 it('uses current operator authority and rejects drift or inactive jobs',async()=>{
  const f=await fixture();await expect(mutateNaiveRemediationTrialPolicy(f.sql,jobId,customerId,f.issue)).rejects.toThrow();
  vi.stubEnv('OPERATOR_EMAILS','');await expect(readNaiveRemediationPolicyStatus(f.sql,jobId,operatorId)).rejects.toThrow();vi.stubEnv('OPERATOR_EMAILS','operator@example.test');
  await expect(mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,{...f.issue,targetVersion:'b'.repeat(64)})).rejects.toThrow();
  await f.pg.query(`UPDATE jobs SET intake=jsonb_set(intake,'{endpoint,systemPrompt}','"drift"'::jsonb) WHERE id=$1`,[jobId]);await expect(mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,f.issue)).rejects.toThrow();
  await f.pg.query(`UPDATE jobs SET state='cancelled' WHERE id=$1`,[jobId]);await expect(readNaiveRemediationPolicyStatus(f.sql,jobId,operatorId)).rejects.toThrow();
 },60000);
 it('rejects substituted identity and corrupted immutable policy',async()=>{
  const f=await fixture();await mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,f.issue);
  await expect(loadNaiveRemediationTrialPolicy(f.sql,{...f.identity,environment:'live'})).rejects.toThrow();
  await f.pg.query(`UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{operationMicroUsd}','999'::jsonb) WHERE kind='naive_remediation_trial_policy'`);
  await expect(loadNaiveRemediationTrialPolicy(f.sql,f.identity)).rejects.toThrow();
 },60000);
});

it('revokes an existing trial after pause and input drift without restoring execution authority',async()=>{
 const f=await fixture();await mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,f.issue);
 await f.pg.query(`UPDATE jobs SET state='paused_budget',intake='{}'::jsonb WHERE id=$1`,[jobId]);
 await mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,{action:'revoke',targetVersion});
 expect(await loadNaiveRemediationTrialPolicy(f.sql,f.identity)).toBeNull();
 await expect(mutateNaiveRemediationTrialPolicy(f.sql,jobId,operatorId,f.issue)).rejects.toThrow();
});
