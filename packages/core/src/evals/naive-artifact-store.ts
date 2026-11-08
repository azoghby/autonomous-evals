/** SQL-backed immutable admission/run artifacts. All policy callbacks run inside the transaction.
 * Callbacks must use the supplied transaction for current owner checks; no external dispatch.
 * Requires the existing text_integration checkpoint migration, never applies it automatically.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentTransactionalSql } from '../agents/postgres-ports';
import { containsSecret } from '../agents/redact';
import type { ServiceContext } from '../contracts/services';
import type { NaiveTextDesignAdmission, NaiveTextDesignAdmissionStore, NaiveTextDesignIdentity } from './naive-design-service';
import { projectFrozenTextSuite, type RetainedTextRun, type TextContractScope } from './naive-contract-mapping';
import { canonicalJson, verifyAdmittedFrozenSuite } from './text/freeze';
import { SuiteRunSchema, ScenarioExecutionSchema, type FrozenTextSuite } from './text/schema';
import { FindingSchema, CostEntrySchema } from './types';
import type { TextInvestigation } from './text/investigate';
import { assertRunMatches } from './text/investigate';
import { TrackBBlockedError } from './service-adapter';

type Tx = Parameters<Parameters<AgentTransactionalSql['transaction']>[0]>[0];
export interface NaiveArtifactScope { jobId: string; customerId: string; environment: 'live' | 'test'; approvalArtifactId?: string; designId?: string; suiteDigest?: string }
export interface NaiveArtifactStoreDeps {
  sql: AgentTransactionalSql;
  /** Must reject revoked/unowned jobs, using this transaction's canonical owner rows. */
  authorize(tx: Tx, scope: NaiveArtifactScope): Promise<{ knownSecrets: readonly string[] }>;
  /** Trusted deterministic review/admission policy, not request/model supplied. Pending is not persisted. */
  decide(tx: Tx, identity: NaiveTextDesignIdentity, suite: FrozenTextSuite): Promise<
    { status: 'approved'; approvalArtifactId: string } | { status: 'pending' | 'rejected' }>;
}
const Scope = z.object({jobId:z.uuid(),customerId:z.string().min(1).max(200),environment:z.enum(['test','live'])});
const Identity = Scope.extend({designId:z.string().min(1).max(96),versionLabel:z.string().min(1).max(64),inputDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const RunScope = Scope.extend({suiteDigest:z.string().regex(/^[a-f0-9]{64}$/),approvalArtifactId:z.string().min(1).max(200)}).strict();
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const fail=():never=>{throw new TrackBBlockedError('rejected_input','Immutable Naive artifact authority or identity mismatch.');};
function safe(v:unknown,secrets:readonly string[]) { if(containsSecret(JSON.stringify(v),secrets))fail(); }
interface Row { input_digest:string; state:string; value:unknown }
export function createNaiveArtifactStore(deps:NaiveArtifactStoreDeps) {
  async function authorized(tx:Tx,scope:NaiveArtifactScope,value:unknown) {
    Scope.parse(scope);
    const policy=await deps.authorize(tx,structuredClone(scope));
    if(!policy || !Array.isArray(policy.knownSecrets) || policy.knownSecrets.some(s=>typeof s!=='string'||s.length<4))fail();
    safe(value,policy.knownSecrets);return policy.knownSecrets;
  }
  async function read(tx:Tx,jobId:string,kind:string,id:string,input:unknown) {
    const row=(await tx.query<Row>('SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR UPDATE',[jobId,kind,id])).rows[0];
    if(row && (row.input_digest!==digest(input)||row.state!=='completed'))fail();
    return row;
  }
  async function save(tx:Tx,jobId:string,kind:string,id:string,input:unknown,value:unknown) {
    const encoded=JSON.stringify(value,(_k,v)=>{if(v===undefined||typeof v==='bigint'||typeof v==='function'||typeof v==='symbol'||typeof v==='number'&&!Number.isFinite(v))fail();return v;});
    await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,$2,$3,$4,$5,'completed',$6::jsonb) ON CONFLICT DO NOTHING`,[jobId,kind,id,digest(input),randomUUID(),encoded]);
    const row=await read(tx,jobId,kind,id,input);
    if(!row||canonicalJson(row.value)!==canonicalJson(value))fail();
  }
  function admissionValue(raw:unknown,identity:NaiveTextDesignIdentity):NaiveTextDesignAdmission {
    const value=raw as NaiveTextDesignAdmission;
    if(!value||canonicalJson(value.identity)!==canonicalJson(identity))fail();
    if(value.status==='rejected')return structuredClone(value);
    if(value.status!=='approved')return fail();
    const scope=RunScope.parse(value.artifact.scope);
    if(scope.jobId!==identity.jobId||scope.customerId!==identity.customerId||scope.environment!==identity.environment)fail();
    const projection=projectFrozenTextSuite(value.artifact.frozen,scope);
    if(value.artifact.schemaVersion!=='naive_contract_suite.v1'||projection.retained.frozen.versionLabel!==identity.versionLabel)fail();
    return structuredClone(value);
  }
  const admission:NaiveTextDesignAdmissionStore={
    async load(raw) {
      const identity=Identity.parse(structuredClone(raw));
      return deps.sql.transaction(async tx=>{
        await authorized(tx,identity,identity);
        const row=await read(tx,identity.jobId,'naive_admission',identity.designId,identity);
        const result=row?admissionValue(row.value,identity):null;
        await authorized(tx,result?.status==='approved'?{...result.artifact.scope,designId:identity.designId}:identity,result);return result;
      });
    },
    async admit(raw,body) {
      const identity=Identity.parse(structuredClone(raw)),suite=verifyAdmittedFrozenSuite(structuredClone(body));
      if(suite.jobId!==identity.jobId||suite.versionLabel!==identity.versionLabel)fail();
      return deps.sql.transaction(async tx=>{
        await authorized(tx,identity,{identity,suite});
        const previous=await read(tx,identity.jobId,'naive_admission',identity.designId,identity);
        if(previous){const retained=admissionValue(previous.value,identity);if(retained.status==='approved'&&canonicalJson(retained.artifact.frozen)!==canonicalJson(suite))fail();await authorized(tx,retained.status==='approved'?{...retained.artifact.scope,designId:identity.designId}:identity,retained);return retained;}
        const decision=await deps.decide(tx,structuredClone(identity),structuredClone(suite));
        let result:NaiveTextDesignAdmission;
        if(decision.status==='pending'){await authorized(tx,identity,{identity,suite});return {identity,status:'pending'};}
        if(decision.status==='rejected')result={identity,status:'rejected'};
        else if(decision.status==='approved') {
          const scope=RunScope.parse({...Scope.parse(identity),suiteDigest:suite.digest,approvalArtifactId:decision.approvalArtifactId});
          result={identity,status:'approved',artifact:projectFrozenTextSuite(suite,scope).retained};
        } else return fail();
        await authorized(tx,result.status==='approved'?{...result.artifact.scope,designId:identity.designId}:identity,result);
        await save(tx,identity.jobId,'naive_admission',identity.designId,identity,result);
        // Index approval to the exact admitted suite, never derive admission from a model response.
        if(result.status==='approved')await save(tx,identity.jobId,'naive_approved_suite',result.artifact.scope.approvalArtifactId,result.artifact.scope,result.artifact);
        await authorized(tx,result.status==='approved'?{...result.artifact.scope,designId:identity.designId}:identity,result);return structuredClone(result);
      });
    }
  };
  async function runSuite(tx:Tx,scope:TextContractScope) {
    const row=await read(tx,scope.jobId,'naive_approved_suite',scope.approvalArtifactId,scope);
    if(!row)return fail();
    const artifact=row.value as {frozen:FrozenTextSuite;scope:TextContractScope};
    if(canonicalJson(artifact.scope)!==canonicalJson(scope))fail();
    return projectFrozenTextSuite(artifact.frozen,scope).retained.frozen;
  }
  return {admission,
    async persistInvestigation(ctx:ServiceContext,raw:{scope:TextContractScope;runId:string;targetVersion:string;investigation:TextInvestigation}) {
      const artifact=structuredClone(raw),scope=RunScope.parse(artifact.scope),v=artifact.investigation;
      if(ctx.jobId!==scope.jobId||ctx.environment!==scope.environment||!artifact.runId||!artifact.targetVersion.trim()||
        !v||!['completed','skipped'].includes(v.investigatorStatus)||!Array.isArray(v.findings)||!Array.isArray(v.costs)||!Array.isArray(v.reproductions)||!Array.isArray(v.testDefects)||!Array.isArray(v.limitations)||v.limitations.some(x=>typeof x!=='string'))fail();
      v.findings.forEach(x=>FindingSchema.parse(x));v.costs.forEach(x=>{CostEntrySchema.parse(x);if(x.jobId!==scope.jobId||!x.measured||!x.externalId)fail();});v.reproductions.forEach(x=>ScenarioExecutionSchema.parse(x));
      const binding={scope,runId:artifact.runId,targetVersion:artifact.targetVersion};
      await deps.sql.transaction(async tx=>{
        await authorized(tx,scope,artifact);
        const suite=await runSuite(tx,scope);
        const retained=await read(tx,scope.jobId,'naive_run_artifact',artifact.runId,binding);if(!retained)fail();
        const baseline=SuiteRunSchema.parse((retained!.value as RetainedTextRun).run);assertRunMatches(suite,baseline);
        for(const execution of v.reproductions){
          if(execution.attempt!=='reproduction')fail();
          assertRunMatches(suite,{...baseline,runId:execution.runId,executions:[execution]});
        }
        const executions=[...baseline.executions,...v.reproductions];
        for(const finding of v.findings){
          if(finding.source!=='text_eval')fail();
          const selected=executions.filter(e=>e.checks.some(c=>finding.id===`text:${e.scenarioId}:${c.checkId}`));
          if(!selected.length)fail();
          for(const evidence of finding.evidence){
            if(evidence.kind==='scenario_response'&&!selected.some(e=>e.runId===evidence.runId&&e.scenarioId===evidence.scenarioId&&(e.responseText?.includes(evidence.quote)||e.checks.some(c=>c.evidenceQuotes.some(q=>q.includes(evidence.quote))))))fail();
            if(evidence.kind==='check'&&!selected.some(e=>e.checks.some(c=>c.checkId===evidence.checkId)))fail();
          }
        }
        await save(tx,scope.jobId,'naive_investigation_artifact',artifact.runId,binding,artifact);
        await authorized(tx,scope,artifact);
      });
    },
    async persistRun(ctx:ServiceContext,raw:RetainedTextRun,identity:{runId:string;targetVersion:string}) {
      const artifact=structuredClone(raw),scope=RunScope.parse(artifact.scope),run=SuiteRunSchema.parse(artifact.run);
      if(artifact.schemaVersion!=='naive_contract_run.v1'||ctx.jobId!==scope.jobId||ctx.environment!==scope.environment||run.runId!==identity.runId||!identity.targetVersion?.trim())fail();
      const binding={scope,runId:identity.runId,targetVersion:identity.targetVersion};
      await deps.sql.transaction(async tx=>{
        await authorized(tx,scope,artifact);const suite=await runSuite(tx,scope);assertRunMatches(suite,run);
        if(run.executions.length!==suite.scenarios.length)fail();
        await save(tx,scope.jobId,'naive_run_artifact',run.runId,binding,{schemaVersion:artifact.schemaVersion,scope,run});
        await authorized(tx,scope,artifact);
      });
    },
    async loadRun(ctx:ServiceContext,raw:TextContractScope,runId:string,targetVersion:string):Promise<RetainedTextRun|null> {
      const scope=RunScope.parse(structuredClone(raw));
      if(ctx.jobId!==scope.jobId||ctx.environment!==scope.environment||!runId||!targetVersion.trim())fail();
      return deps.sql.transaction(async tx=>{
        await authorized(tx,scope,scope);const suite=await runSuite(tx,scope);
        const row=await read(tx,scope.jobId,'naive_run_artifact',runId,{scope,runId,targetVersion});
        if(!row)return null;
        const artifact=row.value as RetainedTextRun,run=SuiteRunSchema.parse(artifact.run);
        if(artifact.schemaVersion!=='naive_contract_run.v1'||canonicalJson(artifact.scope)!==canonicalJson(scope)||run.runId!==runId||run.executions.length!==suite.scenarios.length)fail();
        assertRunMatches(suite,run);await authorized(tx,scope,artifact);return structuredClone(artifact);
      });
    }
  };
}
