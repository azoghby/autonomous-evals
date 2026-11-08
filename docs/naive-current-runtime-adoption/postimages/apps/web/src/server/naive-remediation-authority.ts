import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { Remediation, type Finding as PublicFinding } from '@ae/core/contracts/index';
import type { ServiceContext } from '@ae/core/contracts/services';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { assertRunMatches } from '@ae/core/evals/text/investigate';
import { SuiteRunSchema } from '@ae/core/evals/text/schema';
import { FindingSchema } from '@ae/core/evals/types';
import type { RemediationResult } from '@ae/core/evals/remediation/index';
import { toContractFinding, TrackBBlockedError } from '@ae/core/evals/service-adapter';
import type { createNaiveMethodAuthority } from './naive-method-authority';
type Tx = Parameters<Parameters<AgentTransactionalSql['transaction']>[0]>[0];
type Authority = Awaited<ReturnType<typeof createNaiveMethodAuthority>>;
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const equal=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const fail=():never=>{throw new TrackBBlockedError('rejected_input','Current remediation authority or immutable evidence changed.');};
export interface NaiveRemediationAuthorityDependencies {
 sql:AgentTransactionalSql;
 authority:Authority & {currentInTransaction(tx:Tx,value?:unknown):ReturnType<Authority['current']>};
 /** Required when sql is not already decorated by the active Workflow stage guard. */
 guard?:(tx:Tx)=>Promise<void>;
}
/** Internal owner capability: finding IDs are lookup hints, never evidence or authority. */
export async function createNaiveRemediationAuthority(ctx:ServiceContext,deps:NaiveRemediationAuthorityDependencies){
 const admitted=await deps.authority.resolveSuite();
 let pinned:string|undefined;
 async function read(tx:Tx,kind:string,id:string,input:unknown){
  const row=(await tx.query<{state:string;input_digest:string;value:any}>(`SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR SHARE`,[ctx.jobId,kind,id])).rows[0];
  if(!row||row.state!=='completed'||row.input_digest!==hash(input))return fail();return row.value;
 }
 async function current(tx:Tx,findingId:string,value?:unknown){
  await deps.guard?.(tx);
  const a=await deps.authority.currentInTransaction(tx,value);
  if(!equal(a.binding,admitted.binding))return fail();
  const {scope,runId,frozen}=admitted;
  const designIdentity=await deps.authority.designIdentity(tx);
  const approval=await read(tx,'naive_admission',a.designId,designIdentity);
  if(approval.status!=='approved'||!equal(approval.identity,designIdentity)||!equal(approval.artifact.scope,scope)||!equal(approval.artifact.frozen,frozen))return fail();
  const approved=await read(tx,'naive_approved_suite',scope.approvalArtifactId,scope);
  if(!equal(approved,approval.artifact))return fail();
  const artifactBinding={scope,runId,targetVersion:a.targetVersion};
  // Admission is reauthorized by currentInTransaction; each retained baseline is exact.
  const retained=await read(tx,'naive_run_artifact',runId,artifactBinding);
  const run=SuiteRunSchema.parse(retained.run);
  if(retained.schemaVersion!=='naive_contract_run.v1'||!equal(retained.scope,scope)||run.runId!==runId||run.executions.length!==frozen.scenarios.length)return fail();
  assertRunMatches(frozen,run);
  const runInput={suiteDigest:scope.suiteDigest,targetVersion:a.targetVersion,ids:frozen.scenarios.map(s=>s.id),attempt:'initial',baselineRunId:null};
  if(!equal(await read(tx,'run_result',runId,{environment:ctx.environment,input:runInput}),{environment:ctx.environment,run}))return fail();
  const identity=await read(tx,'run_identity',runId,{environment:ctx.environment,input:runInput});
  if(identity.targetVersion!==a.targetVersion||identity.startedAt!==run.startedAt)return fail();
  const investigation=await read(tx,'naive_investigation_artifact',runId,artifactBinding);
  const rich=investigation.investigation;
  if(!equal(investigation.scope,scope)||investigation.runId!==runId||investigation.targetVersion!==a.targetVersion||!equal(rich,await read(tx,'investigation',runId,{environment:ctx.environment,input:{suiteDigest:scope.suiteDigest,run,targetVersion:a.targetVersion}}))||rich.investigatorStatus!=='completed')return fail();
  const selected=rich.findings.filter((f:{id:string})=>f.id===findingId);
  if(selected.length!==1)return fail();
  const finding=FindingSchema.parse(selected[0]),publicFinding=toContractFinding(finding);
  if(finding.label!=='confirmed'||finding.source!=='text_eval')return fail();
  const rows=(await tx.query<{data:unknown}>(`SELECT data FROM findings WHERE job_id=$1 AND finding_key=$2 AND rerun_of_finding_id IS NULL FOR SHARE`,[ctx.jobId,findingId])).rows;
  if(rows.length>1||rows.some(r=>!equal(r.data,publicFinding)))return fail();
  const failingCheckIds=[...new Set(finding.evidence.filter(e=>e.kind==='check').map(e=>e.checkId))].filter(id=>run.executions.some(e=>e.checks.some(c=>c.checkId===id&&c.kind==='objective'&&c.status==='fail')));
  if(!failingCheckIds.length)return fail();
  const binding={targetId:ctx.jobId,targetVersion:a.targetVersion,environment:ctx.environment};
  const proof={binding:a.binding,scope,frozen,run,rich,finding,publicFinding};
  if(pinned&&pinned!==hash(proof))return fail();
  return {job:a.job,finding,publicFinding,knownSecrets:a.knownSecrets,binding,original:{suite:frozen,run,binding,failingCheckIds},target:a.target,scope,runId,proof};
 }
 let selectedId:string|undefined;
 return {
  async resolve(findingId:string,requested?:PublicFinding){
   if(selectedId&&selectedId!==findingId)return fail();
   const a=await deps.sql.transaction(tx=>current(tx,findingId,requested));
   if(requested&&!equal(requested,a.publicFinding))return fail();
   selectedId=findingId;pinned=hash(a.proof);return a;
  },
  async assertCurrentInTransaction(tx:Tx,value?:unknown){if(!selectedId)return fail();await current(tx,selectedId,value);},
  async assertCurrent(value?:unknown){if(!selectedId)return fail();await deps.sql.transaction(tx=>current(tx,selectedId!,value));},
  async retain(detailed:RemediationResult){
   if(!selectedId)return fail();
   return deps.sql.transaction(async tx=>{
    const a=await current(tx,selectedId!,detailed),projection=Remediation.parse(detailed.remediation);
    if(!equal(projection,detailed.remediation)||projection.findingId!==a.finding.id||detailed.baselineRunId!==a.runId||detailed.suiteDigest!==a.scope.suiteDigest)return fail();
    const input={evidenceDigest:pinned,findingId:a.finding.id},value={schemaVersion:'naive_remediation_receipt.v1',input,detailed,receiptDigest:hash({input,detailed})};
    await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_remediation_receipt',$2,$3,$4,'completed',$5::jsonb) ON CONFLICT DO NOTHING`,[ctx.jobId,a.finding.id,hash(input),randomUUID(),JSON.stringify(value)]);
    if(!equal(await read(tx,'naive_remediation_receipt',a.finding.id,input),value))return fail();
    // Immutable detailed receipt precedes the public projection in this same transaction.
    await tx.query(`INSERT INTO findings(job_id,finding_key,data) SELECT $1,$2,$3::jsonb WHERE NOT EXISTS (SELECT 1 FROM findings WHERE job_id=$1 AND finding_key=$2 AND rerun_of_finding_id IS NULL)`,[ctx.jobId,a.finding.id,JSON.stringify(a.publicFinding)]);
    const rows=(await tx.query<{id:string;data:unknown}>(`SELECT id::text,data FROM findings WHERE job_id=$1 AND finding_key=$2 AND rerun_of_finding_id IS NULL FOR UPDATE`,[ctx.jobId,a.finding.id])).rows;
    if(rows.length!==1||!equal(rows[0].data,a.publicFinding))return fail();
    await tx.query(`INSERT INTO remediations(job_id,finding_row_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,[ctx.jobId,rows[0].id,JSON.stringify(projection)]);
    const saved=(await tx.query<{data:unknown}>(`SELECT data FROM remediations WHERE job_id=$1 AND finding_row_id=$2 FOR UPDATE`,[ctx.jobId,rows[0].id])).rows;
    if(saved.length!==1||!equal(saved[0].data,projection))return fail();
    await current(tx,selectedId!,detailed);return projection;
   });
  }
 };
}
