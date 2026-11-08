import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isOperator } from '@ae/core/auth/tokens';
import type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { canonicalJson } from '@ae/core/evals/text/freeze';

const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const denied = (): never => { throw new Error('naive_remediation_policy_unavailable'); };
const Identity = z.object({ jobId: z.uuid(), customerId: z.uuid(), environment: z.enum(['test','live']), targetVersion: z.string().regex(/^[a-f0-9]{64}$/) });
const Policy = Identity.extend({ schemaVersion: z.literal('naive_remediation_trial_policy.v1'), kind: z.literal('stateless_chat_completions'), isolation: z.literal('request_messages_only'), operationMicroUsd: z.number().int().min(1).max(100_000), issuedByOperator: z.uuid() }).strict();
export type NaiveRemediationTrialPolicy = z.infer<typeof Policy>;
export type RemediationPolicyIdentity = z.infer<typeof Identity>;
export const RemediationPolicyMutation = z.discriminatedUnion('action',[
  z.object({ action: z.literal('issue'), targetVersion: Identity.shape.targetVersion, kind: z.literal('stateless_chat_completions'), isolation: z.literal('request_messages_only'), declaresStateless: z.literal(true), operationMicroUsd: Policy.shape.operationMicroUsd }).strict(),
  z.object({ action: z.literal('revoke'), targetVersion: Identity.shape.targetVersion }).strict(),
]);
type Row = { state:string; input_digest:string; value:unknown };
async function retained(tx:AgentSqlExecutor, jobId:string, kind:string, id:string) {
  return (await tx.query<Row>('SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR SHARE',[jobId,kind,id])).rows[0];
}
/** Called under current canonical job authority; this declaration never grants target authority alone. */
export async function loadNaiveRemediationTrialPolicy(tx:AgentSqlExecutor, expected:RemediationPolicyIdentity):Promise<NaiveRemediationTrialPolicy|null> {
  const identity=Identity.parse(expected);
  if(await retained(tx,identity.jobId,'naive_remediation_trial_revocation',identity.targetVersion))return null;
  const row=await retained(tx,identity.jobId,'naive_remediation_trial_policy',identity.targetVersion);
  if(!row)return null;
  const parsed=Policy.safeParse(row.value);
  if(!parsed.success||row.state!=='completed'||row.input_digest!==digest(parsed.data)||Object.entries(identity).some(([key,value])=>parsed.data[key as keyof NaiveRemediationTrialPolicy]!==value))return denied();
  return parsed.data;
}
async function operatorJob(tx:AgentSqlExecutor,jobId:string,operatorId:string, revokeTargetVersion?:string) {
  const job=(await tx.query<{customer_id:string;environment:'test'|'live';package:string;is_mock:boolean;state:string;intake:unknown}>('SELECT customer_id::text,environment,package,is_mock,state,intake FROM jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
  const viewer=(await tx.query<{email:string}>('SELECT email FROM customers WHERE id=$1 FOR SHARE',[operatorId])).rows[0];
  if(!viewer||!isOperator(viewer.email)||!job||job.package!=='text_eval'||job.is_mock||!revokeTargetVersion&&!['planning','running','investigating'].includes(job.state))return denied();
  // Revocation removes authority even after a job is paused or its input changes.
  if(revokeTargetVersion)return {jobId,customerId:job.customer_id,environment:job.environment,targetVersion:revokeTargetVersion};
  const rows=(await tx.query<Row>("SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_method_binding' FOR SHARE",[jobId])).rows;
  if(rows.length!==1)return denied();
  const row=rows[0]!,binding=row.value as {job?:{jobId:string;customerId:string;environment:string};intakeDigest?:string;targetVersion?:string};
  if(row.state!=='completed'||row.input_digest!==digest(binding)||binding.job?.jobId!==jobId||binding.job.customerId!==job.customer_id||binding.job.environment!==job.environment||binding.intakeDigest!==digest(job.intake)||!Identity.shape.targetVersion.safeParse(binding.targetVersion).success)return denied();
  return {jobId,customerId:job.customer_id,environment:job.environment,targetVersion:binding.targetVersion!};
}
export async function readNaiveRemediationPolicyStatus(sql:AgentTransactionalSql, jobId:string, operatorId:string) {
  return sql.transaction(async tx=>{const identity=await operatorJob(tx,jobId,operatorId);const policy=await loadNaiveRemediationTrialPolicy(tx,identity);return {targetVersion:identity.targetVersion,policy,status:await retained(tx,jobId,'naive_remediation_trial_revocation',identity.targetVersion)?'revoked':policy?'active':'not_configured'};});
}
export async function mutateNaiveRemediationTrialPolicy(sql:AgentTransactionalSql,jobId:string,operatorId:string,raw:unknown):Promise<void> {
  const input=RemediationPolicyMutation.parse(raw);
  await sql.transaction(async tx=>{
    const identity=await operatorJob(tx,jobId,operatorId,input.action==='revoke'?input.targetVersion:undefined);
    if(identity.targetVersion!==input.targetVersion)return denied();
    const kind=input.action==='issue'?'naive_remediation_trial_policy':'naive_remediation_trial_revocation';
    if(input.action==='issue'&&await retained(tx,jobId,'naive_remediation_trial_revocation',identity.targetVersion))return denied();
    const value=input.action==='issue'?Policy.parse({...identity,schemaVersion:'naive_remediation_trial_policy.v1',kind:input.kind,isolation:input.isolation,operationMicroUsd:input.operationMicroUsd,issuedByOperator:operatorId}):{...identity,revokedByOperator:operatorId};
    const prior=await retained(tx,jobId,kind,identity.targetVersion);
    if(prior){if(prior.state!=='completed'||prior.input_digest!==digest(prior.value)||canonicalJson(prior.value)!==canonicalJson(value))return denied();return;}
    await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,$2,$3,$4,$5,'completed',$6::jsonb)`,[jobId,kind,identity.targetVersion,digest(value),randomUUID(),JSON.stringify(value)]);
    await tx.query("INSERT INTO interventions(job_id,operator_email,kind,note) SELECT $1,email,'other',$3 FROM customers WHERE id=$2",[jobId,operatorId,input.action==='issue'?'Declared exact target suitable for request-only remediation trials.':'Revoked remediation trial policy.']);
  });
}
