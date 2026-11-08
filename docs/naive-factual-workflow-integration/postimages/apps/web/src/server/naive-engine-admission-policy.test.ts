import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { describe,it,expect } from 'vitest';
import { designTextSuite } from '@ae/core/evals/text/design';
import { canonicalJson, freezeSuite } from '@ae/core/evals/text/freeze';
import { makeScenarios } from '@ae/core/evals/text/__tests__/fixtures';
import { taskKeyFor,outputJsonSchema,type AgentTaskRunner } from '@ae/core/agents/session-service';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import { createNaiveEngineAdmissionPolicy } from './naive-engine-admission-policy';
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
async function fixture(){
 const pg=new PGlite();
 for(const path of ['packages/core/src/evals/integration/migrations/001-text-integration.sql','packages/core/src/agents/persistence-migrations/001-agent-persistence.sql'])await pg.exec(readFileSync(resolve(path),'utf8'));
 await pg.exec(`CREATE TABLE jobs(id text PRIMARY KEY,customer_id text,environment text);INSERT INTO jobs VALUES('generic-policy-job','owner','test');`);
 const tx:AgentSqlExecutor={query:(q,p)=>pg.query(q,p)};
 const job={jobId:'generic-policy-job',customerId:'owner',environment:'test' as const,package:'text_eval' as const,isFixture:false,quoteVersion:null,linkedRetestOf:null};
 const identity={jobId:job.jobId,customerId:job.customerId,environment:job.environment,designId:'generic-text-v1',versionLabel:'generic-text-v1',inputDigest:hash('canonical-authorized-intake')};
 const input={suiteId:identity.designId,versionLabel:identity.versionLabel,systemPrompt:'Follow the explicit user constraints.',referenceText:null};
 const runner={run:async(spec:any)=>{
  const key=taskKeyFor(job.jobId,spec.role,spec.purpose,1),sessionId=`session-${spec.role}`;
  const result=spec.role==='evaluation_engineer'?{scenarios:makeScenarios()}:{verdicts:makeScenarios().map(s=>({scenarioId:s.id,accepted:true,reasons:[]}))};
  const record={taskKey:key,jobId:job.jobId,role:spec.role,purpose:spec.purpose,attempt:1,state:'completed',sessionId,agentId:`agent-${spec.role}`,agentVersion:1,consumedMicroUsd:7,tokenUsage:{},error:null,result,updatedAt:'2026-11-08T00:00:00.000Z',requestBody:{agent_id:`agent-${spec.role}`,agent_version:1,message:spec.message,output_schema:outputJsonSchema(spec.output.schema),structured_output_required:true,metadata:{ae_task_key:key,ae_job_id:job.jobId,ae_role:spec.role,ae_purpose:spec.purpose,ae_output:spec.output.name,ae_environment:'test',ae_fixture:false,ae_package:'text_eval'}}};
  await pg.query('INSERT INTO agent_persistence.tasks VALUES($1,1,$2)',[key,JSON.stringify(record)]);
  return {status:'completed',taskKey:key,output:result,session:{sessionId},cost:{jobId:job.jobId,source:'naive_session',role:spec.role,externalId:sessionId,purpose:spec.purpose,microUsd:7,measured:true,recordedAt:record.updatedAt}};
 }} as unknown as AgentTaskRunner;
 const outcome=await designTextSuite({job,versionLabel:input.versionLabel,systemPrompt:input.systemPrompt,referenceText:input.referenceText},{runner,now:()=>new Date('2026-11-08T00:00:00.000Z')});if(outcome.status!=='completed')throw Error(outcome.reason);
 const binding={job,designId:identity.designId,versionLabel:identity.versionLabel,intakeDigest:hash('intake'),targetVersion:hash('target')};
 async function checkpoint(kind:string,digest:string,value:unknown){await pg.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,$2,$3,$4,'token','completed',$5)`,[job.jobId,kind,identity.designId,digest,JSON.stringify(value)]);}
 await checkpoint('naive_method_binding',hash(binding),binding);await checkpoint('design',hash({environment:job.environment,input}),outcome);
 return {pg,tx,identity,suite:outcome.suite,policy:createNaiveEngineAdmissionPolicy()};
}
describe('automated generic admission on real SQL migrations',{timeout:30000},()=>{
 it('approves completed independent retained design, stable fresh-factory replay and current validation',async()=>{const f=await fixture();try{const a=await f.policy.admissionPolicy(f.tx,f.identity,f.suite);expect(a.status).toBe('approved');expect(await createNaiveEngineAdmissionPolicy().admissionPolicy(f.tx,f.identity,f.suite)).toEqual(a);if(a.status==='approved')await f.policy.authorizeApproval(f.tx,a.approvalArtifactId,f.identity);}finally{await f.pg.close();}});
 it('missing or pending engine design remains pending',async()=>{const f=await fixture();try{await f.pg.query(`UPDATE text_integration.checkpoints SET state='pending',value=NULL WHERE kind='design'`);expect(await f.policy.admissionPolicy(f.tx,f.identity,f.suite)).toEqual({status:'pending'});await f.pg.query(`DELETE FROM text_integration.checkpoints WHERE kind='design'`);expect(await f.policy.admissionPolicy(f.tx,f.identity,f.suite)).toEqual({status:'pending'});}finally{await f.pg.close();}});
 it('rejects a valid rehashed foreign body and foreign identity',async()=>{const f=await fixture();try{const {digest,...body}=f.suite;await expect(f.policy.admissionPolicy(f.tx,f.identity,freezeSuite({...body,frozenAt:'2026-11-08T01:00:00.000Z'}))).rejects.toThrow();await expect(f.policy.admissionPolicy(f.tx,{...f.identity,customerId:'foreign'},f.suite)).rejects.toThrow();}finally{await f.pg.close();}});
 it('rejects a rehashed forged checkpoint body despite matching review assertions',async()=>{const f=await fixture();try{const {digest,...body}=f.suite;const forged=freezeSuite({...body,scenarios:body.scenarios.map((s,i)=>i===0?{...s,title:'Forged title'}:s)});await f.pg.query(`UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{suite}',$1::jsonb) WHERE kind='design'`,[JSON.stringify(forged)]);await expect(f.policy.admissionPolicy(f.tx,f.identity,forged)).rejects.toThrow();}finally{await f.pg.close();}});
 it('honors the supplied transaction and its rollback',async()=>{const f=await fixture();try{const a=await f.policy.admissionPolicy(f.tx,f.identity,f.suite);expect(a.status).toBe('approved');await expect(f.pg.transaction(async db=>{const tx:AgentSqlExecutor={query:(q,p)=>db.query(q,p)};await tx.query(`UPDATE agent_persistence.tasks SET record=jsonb_set(record,'{state}','"needs_operator"')`);if(a.status==='approved')await f.policy.authorizeApproval(tx,a.approvalArtifactId,f.identity);})).rejects.toThrow();if(a.status==='approved')await f.policy.authorizeApproval(f.tx,a.approvalArtifactId,f.identity);}finally{await f.pg.close();}});
 for(const [name,sql] of [
 ['foreign job',`UPDATE agent_persistence.tasks SET record=jsonb_set(record,'{jobId}','"foreign"') WHERE record->>'role'='quality_investigator'`],
 ['missing review',`DELETE FROM agent_persistence.tasks WHERE record->>'role'='quality_investigator'`],
 ['revoked session',`UPDATE agent_persistence.tasks SET record=jsonb_set(record,'{state}','"needs_operator"') WHERE record->>'role'='quality_investigator'`],
 ['changed message',`UPDATE agent_persistence.tasks SET record=jsonb_set(record,'{requestBody,message}','"forged"') WHERE record->>'role'='quality_investigator'`],
 ['changed output',`UPDATE agent_persistence.tasks SET record=jsonb_set(record,'{result,verdicts,0,accepted}','false') WHERE record->>'role'='quality_investigator'`],
 ['forged engine review',`UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{suite,review,sessions,1,sessionId}','"forged-session"') WHERE kind='design'`],
 ['changed revision',`UPDATE agent_persistence.tasks SET revision=revision+1`],
 ] as const)it(`rejects ${name} on retained approval replay`,async()=>{const f=await fixture();try{const a=await f.policy.admissionPolicy(f.tx,f.identity,f.suite);expect(a.status).toBe('approved');await f.pg.exec(sql);if(a.status==='approved')await expect(f.policy.authorizeApproval(f.tx,a.approvalArtifactId,f.identity)).rejects.toThrow();}finally{await f.pg.close();}});
});

describe('initial admission request pin enforcement',()=>{
 for(const [name,sql] of [
  ['unversioned request',`UPDATE agent_persistence.tasks SET record=record #- '{requestBody,agent_version}'`],
  ['wrong requested schema',`UPDATE agent_persistence.tasks SET record=jsonb_set(record,'{requestBody,output_schema}','{}')`],
 ] as const)it(`refuses ${name} before issuing an approval`,async()=>{const f=await fixture();try{await f.pg.exec(sql);await expect(f.policy.admissionPolicy(f.tx,f.identity,f.suite)).rejects.toThrow();}finally{await f.pg.close();}});
});
