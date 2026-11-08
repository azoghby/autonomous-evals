import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { reviewDigest } from '@ae/core/evals/data/binding';

const identitySchema = z.object({ jobId: z.string().uuid(), customerId: z.string().uuid(), environment: z.enum(['test','live']) }).strict();
export type NaiveTextExecutionIdentity = z.infer<typeof identitySchema>;
const legacy = { policyId:'generic-text-v1', designId:'generic-text-v1', versionLabel:'generic-text-v1', admissionPolicyId:'automated-text-design-v1' } as const;
const factual = { policyId:'generic-text-factual-gap-v1', designId:'generic-text-factual-gap-v1', versionLabel:'generic-text-factual-gap-v1', admissionPolicyId:'automated-text-design-factual-gap-v1', factualGapPolicy:'propose_missing_reference.v1' } as const;
const task = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/);
const legacySchema = z.object({policyId:z.literal(legacy.policyId),designId:z.literal(legacy.designId),versionLabel:z.literal(legacy.versionLabel),admissionPolicyId:z.literal(legacy.admissionPolicyId)}).strict();
const factualSchema = z.object({policyId:z.literal(factual.policyId),designId:z.literal(factual.designId),versionLabel:z.literal(factual.versionLabel),admissionPolicyId:z.literal(factual.admissionPolicyId),factualGapPolicy:z.literal(factual.factualGapPolicy),expertTaskId:task}).strict();
const selectionSchema = z.object({schemaVersion:z.literal('naive_text_execution_selection.v1'),identity:identitySchema,profile:z.union([legacySchema,factualSchema])}).strict();
export type NaiveTextExecutionProfile = z.infer<typeof selectionSchema>['profile'];
type Selection = z.infer<typeof selectionSchema>;
const fail = ():never => { throw new Error('naive_text_execution_selection_conflict'); };
async function canonicalJob(tx:AgentSqlExecutor,identity:NaiveTextExecutionIdentity){
 identity=identitySchema.parse(identity);
 const row=(await tx.query<{customer_id:string;environment:string;package:string;is_mock:boolean}>('SELECT customer_id::text,environment,package,is_mock FROM jobs WHERE id=$1 FOR UPDATE',[identity.jobId])).rows[0];
 if(!row||row.customer_id!==identity.customerId||row.environment!==identity.environment||row.package!=='text_eval'||row.is_mock)return fail();
}
async function bindings(tx:AgentSqlExecutor,identity:NaiveTextExecutionIdentity,profile?:NaiveTextExecutionProfile){
 const rows=(await tx.query<{id:string;state:string;input_digest:string;value:any}>(`SELECT id,state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_method_binding' FOR SHARE`,[identity.jobId])).rows;
 if(rows.length>1)return fail();
 for(const r of rows){
  if(!profile||r.id!==profile.designId||r.state!=='completed'||r.input_digest!==reviewDigest(r.value)||r.value?.designId!==profile.designId||r.value?.versionLabel!==profile.versionLabel||r.value?.job?.jobId!==identity.jobId||r.value?.job?.customerId!==identity.customerId||r.value?.job?.environment!==identity.environment)return fail();
 }
 return rows.length;
}
async function retained(tx:AgentSqlExecutor,identity:NaiveTextExecutionIdentity):Promise<Selection|null>{
 const row=(await tx.query<{state:string;input_digest:string;value:unknown}>(`SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_execution_policy' AND id='selection-v1' FOR UPDATE`,[identity.jobId])).rows[0];
 if(!row)return null;
 const parsed=selectionSchema.safeParse(row.value);
 if(!parsed.success||row.state!=='completed'||row.input_digest!==reviewDigest(parsed.data)||reviewDigest(parsed.data.identity)!==reviewDigest(identity))return fail();
 return parsed.data;
}
async function pin(tx:AgentSqlExecutor,value:Selection){
 await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_execution_policy','selection-v1',$2,$3,'completed',$4::jsonb) ON CONFLICT DO NOTHING`,[value.identity.jobId,reviewDigest(value),randomUUID(),JSON.stringify(value)]);
 const saved=await retained(tx,value.identity);
 if(!saved||reviewDigest(saved)!==reviewDigest(value))return fail();
 return saved.profile;
}
/** Caller MUST invoke in the same transaction that inserts this previously nonexistent job,
 * before exposing it. This function never opens a nested transaction. Calling it later is
 * not authorized enrollment; absence of evaluation rows alone does not establish newness. */
export async function enrollNewNaiveTextExecution(tx:AgentSqlExecutor,identity:NaiveTextExecutionIdentity,options:{factualGapEnabled:boolean;expertTaskId?:string}):Promise<NaiveTextExecutionProfile>{
 identity=identitySchema.parse(identity);await canonicalJob(tx,identity);
 const profile:NaiveTextExecutionProfile=options.factualGapEnabled?{...factual,expertTaskId:task.parse(options.expertTaskId)}:{...legacy};
 const saved=await retained(tx,identity);
 if(saved){if(reviewDigest(saved.profile)!==reviewDigest(profile))return fail();await bindings(tx,identity,profile);return saved.profile;}
 // A new job cannot already own a design operation of any version.
 await bindings(tx,identity);
 return pin(tx,{schemaVersion:'naive_text_execution_selection.v1',identity,profile});
}
/** Runtime resolution NEVER upgrades a job without its atomic enrollment marker. Flags
 * are current execution permission only; rollback retains selected identity and holds. */
export async function resolveNaiveTextExecution(sql:AgentTransactionalSql,identity:NaiveTextExecutionIdentity,options:{realMode:boolean;factualGapEnabled:boolean}):Promise<{status:'ready'|'on_hold';profile:NaiveTextExecutionProfile}>{
 identity=identitySchema.parse(identity);
 return sql.transaction(async tx=>{
  await canonicalJob(tx,identity);
  const saved=await retained(tx,identity);
  const profile=saved?.profile??{...legacy};
  await bindings(tx,identity,profile);
  if(!saved)await pin(tx,{schemaVersion:'naive_text_execution_selection.v1',identity,profile});
  return {status:!options.realMode||profile.policyId===factual.policyId&&!options.factualGapEnabled?'on_hold':'ready',profile};
 });
}
