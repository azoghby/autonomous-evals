import { createAutonomousPaidContext, type AutonomousPaidContext, type PaidMonitor, type PaidReceipt } from './autonomous-paid';
import { deliverRemediationCost } from './rich-remediation';
import 'server-only';
import { AgentSessionService } from '@ae/core/agents/session-service';
import { PostgresAgentTaskStore, PostgresBudgetLedger, type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { createAutonomousBudgetLedger, createAutonomousPaidReservationPolicy } from '@ae/core/agents/autonomy/budget';
import { PostgresAutonomySupervisor } from '@ae/core/agents/autonomy/supervisor';
import { createAutonomousRunner } from '@ae/core/agents/autonomy/runner';
import { AUTONOMY_ROLES, createAutonomousPolicy, autonomyDigest, type AutonomousPolicy } from '@ae/core/agents/autonomy/policy';
import { advanceAutonomousCompany, type CompanyRequest, type CompanyPorts } from '@ae/core/agents/autonomy/company';
import type { NaiveSessionsPort } from '@ae/core/evals/types';
import type { DataOperationLedger } from '@ae/core/evals/data/operation-ledger';
import type { FixedQuote } from '@ae/core/agents/commercial';

export interface ReleasePrincipal { tenantId: string; subject: string }
type Binding = { tenant_id: string; job_id: string; owner_id: string; policy_version: string; authority_digest: string | null; request: CompanyRequest; enabled: boolean };
export interface ReleasePaymentReceipt { receipt_id: string; settled: boolean; amount_micro_usd: string | number | null; currency: string; record: { quoteDigest: string; [key: string]: unknown } }
export interface ReleaseConfig {
  db: AgentTransactionalSql;
  /** Authentication is owner supplied; never compare an optional environment token with undefined. */
  authenticateScheduler(credential: unknown): Promise<boolean>;
  authenticateCustomer(credential: unknown): Promise<ReleasePrincipal | null>;
  /** Canonical owner job/intake read. Never accept a caller-supplied CompanyRequest. */
  loadRequest(principal: ReleasePrincipal, jobId: string): Promise<CompanyRequest | null>;
  authorizeJob(principal: ReleasePrincipal, request: CompanyRequest): Promise<boolean>;
  policyFor(tenantId: string): Promise<AutonomousPolicy | null>;
  currentSecrets(request: CompanyRequest): Promise<readonly string[]>;
  /** Genuine durable, idempotent provider transport. No production defaults or fabricated agents. */
  naive: NaiveSessionsPort;
  workerId: string;
  idempotencyNamespace: string;
  operationsFor(request: CompanyRequest): Promise<DataOperationLedger>;
  /** Exact independently reviewed source IDs/digests are resolved by this server adapter. */
  sourcePermissions(request: CompanyRequest): Promise<readonly { sourceId: string; permissionDigest: string }[]>;
  /** Verify the retained webhook/processor receipt with the configured authoritative payment adapter. */
  verifyPayment(request: CompanyRequest, quote: FixedQuote, receipt: ReleasePaymentReceipt): Promise<boolean>;
  /** Read/reconcile a genuine provider receipt, not an agent assertion. No redispatch here. */
  verifyProviderReceipt(request: CompanyRequest, receipt: { provider_id: string; receipt: unknown }): Promise<boolean>;
  data(request: CompanyRequest, key: string, paid: AutonomousPaidContext): ReturnType<CompanyPorts['data']>;
  /** Frozen server configuration, reloaded with current company authority; never an HTTP/body value. */
  paidPolicy(request: CompanyRequest): Promise<{jobCapMicroUsd:number;targetReservationMicroUsd:number;judgeReservationMicroUsd:number}>;
  verifyPaidReceipt?(request: CompanyRequest, receipt: Readonly<PaidReceipt>): Promise<boolean>;
  evaluate(request: CompanyRequest, key: string, digest: string, runner: CompanyPorts['runner'], paid: AutonomousPaidContext): ReturnType<CompanyPorts['evaluate']>;
  recoverEvaluation(request: CompanyRequest, key: string): ReturnType<CompanyPorts['recoverEvaluation']>;
  enqueue(request: CompanyRequest, key: string, message: Parameters<CompanyPorts['enqueue']>[1], paid: AutonomousPaidContext): Promise<void>;
  now(): number;
}
const refuse = (): never => { throw new Error('autonomy_release_authority_refused'); };
const validId = (id: string) => typeof id === 'string' && /^[A-Za-z0-9_.:@/-]{1,200}$/.test(id);

/** Additive owner root. Authentication precedes all reads; every adapter rechecks the persisted
 * tenant/job/owner/policy binding. Scheduler ticks reuse durable identities, never Workflow starts.
 * Human review rows are neither read as automated authority nor overwritten by this path. */
export function createAutonomyReleaseServer(config: ReleaseConfig) {
  async function principal(credential: unknown) {
    const p = await config.authenticateCustomer(credential);
    if (!p || !validId(p.tenantId) || !validId(p.subject)) return refuse();
    return p;
  }
  async function binding(tenantId: string, jobId: string) {
    return (await config.db.query<Binding>('SELECT tenant_id,job_id,owner_id,policy_version,authority_digest,request,enabled FROM company_autonomy_release.job_bindings WHERE tenant_id=$1 AND job_id=$2',[tenantId,jobId])).rows[0];
  }
  async function current(row: Binding, expected?: AutonomousPolicy) {
    if (!row || !row.enabled || row.tenant_id !== row.request.tenantId || row.job_id !== row.request.job.jobId || row.tenant_id !== row.request.job.customerId) return refuse();
    const fresh = await binding(row.tenant_id,row.job_id);
    if (!fresh?.enabled || autonomyDigest(fresh.request) !== autonomyDigest(row.request) || fresh.owner_id !== row.owner_id || fresh.policy_version !== row.policy_version || !row.authority_digest || fresh.authority_digest!==row.authority_digest) return refuse();
    const policyInput = await config.policyFor(row.tenant_id);
    if (!policyInput) return refuse();
    const policy = createAutonomousPolicy(policyInput);
    if (policy.tenantId !== row.tenant_id || policy.version !== row.policy_version || expected && autonomyDigest(expected) !== autonomyDigest(policy)) return refuse();
    const paidPolicy=await config.paidPolicy(structuredClone(row.request));
    if(row.authority_digest!==autonomyDigest({policy,paidPolicy})) return refuse();
    const p = {tenantId:row.tenant_id,subject:row.owner_id};
    const canonical = await config.loadRequest(p,row.job_id);
    if (!canonical || autonomyDigest(canonical) !== autonomyDigest(row.request) || !await config.authorizeJob(p,structuredClone(row.request))) return refuse();
    return policy;
  }
  async function ports(row: Binding): Promise<CompanyPorts> {
    const request = structuredClone(row.request), policy = await current(row);
    const paidPolicy=Object.freeze({...await config.paidPolicy(request)});
    const guard = async () => {
      await current(row,policy);
      if(autonomyDigest(await config.paidPolicy(request))!==autonomyDigest(paidPolicy)) return refuse();
    };
    const supervisor = new PostgresAutonomySupervisor(config.db,policy,async (tenantId,jobId) => {
      if (tenantId !== request.tenantId || jobId !== request.job.jobId) return false;
      await guard(); return true;
    });
    const naive: NaiveSessionsPort = {
      async createSession(body,key){await guard();return config.naive.createSession(body,key);},
      async getSession(id){await guard();return config.naive.getSession(id);},
      async listAgentSessions(id,page){await guard();return config.naive.listAgentSessions(id,page);},
    };
    const makeService = (monitor?:PaidMonitor) => new AgentSessionService({naive,store:new PostgresAgentTaskStore(config.db),
      ledger:createAutonomousBudgetLedger(monitor ? {
        reserve:request=>new PostgresBudgetLedger(config.db).reserve({...request,scopes:[...request.scopes,{key:monitor.key,capMicroUsd:monitor.capMicroUsd}]}),
        settle:(id,cost)=>new PostgresBudgetLedger(config.db).settle(id,cost),
      } : new PostgresBudgetLedger(config.db),policy),
      directory:Object.fromEntries(AUTONOMY_ROLES.map(role=>[role,{agentId:policy.agents[role].id,agentVersion:policy.agents[role].version}])) as ConstructorParameters<typeof AgentSessionService>[0]['directory'],
      budgetPeriodId:policy.periodId,idempotencyNamespace:config.idempotencyNamespace,workerId:config.workerId,maxWaitMs:0,clock:{now:()=>new Date(config.now())}});
    const autonomous = createAutonomousRunner({supervisor,runner:makeService(),now:config.now,
      currentPolicyVersion:async()=>{await guard();return policy.version;},currentSecrets:()=>config.currentSecrets(request)});
    const runner: CompanyPorts['runner'] = {async run(spec){await guard(); if(autonomyDigest(spec.job)!==autonomyDigest(request.job))return refuse(); return autonomous.run(spec);}};
    const paid=createAutonomousPaidContext({sql:config.db,policy,job:request.job,runner,guard,...paidPolicy,
      runnerForMonitor:monitor=>createAutonomousRunner({supervisor,runner:makeService(monitor),now:config.now,
        currentPolicyVersion:async()=>{await guard();return policy.version;},currentSecrets:()=>config.currentSecrets(request)}),
      deliverCost:deliverRemediationCost,verifyReceipt:receipt=>config.verifyPaidReceipt?.(request,receipt) ?? Promise.resolve(false)});
    const ledger = await config.operationsFor(request);
    const operations: DataOperationLedger = {
      async claim(key,digest){await guard();return ledger.claim(key,digest);},
      async get(key){await guard();return ledger.get(key);},
      async complete(key,digest,result,receipt){await guard();return ledger.complete(key,digest,result,receipt);},
    };
    const authorizeSources = async () => {
      await guard(); const required=await config.sourcePermissions(request);
      if(!required.length)return false;
      for(const source of required){
        if(!/^[a-f0-9]{64}$/.test(source.permissionDigest))return refuse();
        const rows=await config.db.query<{allowed:boolean;expires_at:string|number;permission_digest:string}>('SELECT allowed,expires_at,permission_digest FROM company_autonomy_release.source_permissions WHERE tenant_id=$1 AND job_id=$2 AND source_id=$3',[row.tenant_id,row.job_id,source.sourceId]);
        const saved=rows.rows[0];
        if(!saved?.allowed || Number(saved.expires_at)<=config.now() || saved.permission_digest!==source.permissionDigest)return false;
      }
      await guard();return true;
    };
    return {now:()=>new Date(config.now()),policy:{schema:'autonomous-company-v1',version:policy.version,enabled:true,maxClarificationRounds:2},operations,runner:paid.runner,
      authorize:async input=>{if(autonomyDigest(input)!==autonomyDigest(request))return false;await guard();return true;},
      async payment(quote){
        await guard();
        const receipts = await config.db.query<ReleasePaymentReceipt>('SELECT receipt_id,settled,amount_micro_usd,currency,record FROM company_autonomy_release.payment_receipts WHERE tenant_id=$1 AND job_id=$2',[row.tenant_id,row.job_id]);
        let invalid=false;
        for(const receipt of receipts.rows) {
          if(receipt.record.quoteDigest!==autonomyDigest(quote))continue;
          if(!receipt.settled)continue;
          if(receipt.settled && receipt.currency==='USD' && Number.isSafeInteger(Number(receipt.amount_micro_usd)) && Number(receipt.amount_micro_usd)>=quote.priceMicroUsd && await config.verifyPayment(request,quote,receipt)){await guard();return 'paid';}
          invalid=true;
        }
        await guard();return invalid?'invalid':'waiting';
      },
      async data(key){
        if(!await authorizeSources())return {status:'not_assessed',digest:'',reasons:['source_permission_missing_expired_or_changed']};
        await guard();const result=await config.data(request,key,paid);if(!await authorizeSources())return refuse();return result;
      },
      async evaluate(key,digest){if(!await authorizeSources())return refuse();const result=await config.evaluate(request,key,digest,paid.runner,paid);if(!await authorizeSources())return refuse();return result;},
      async recoverEvaluation(key){
        if(!await authorizeSources())return refuse();
        const rows=await config.db.query<{provider_id:string;receipt:unknown}>('SELECT provider_id,receipt FROM company_autonomy_release.provider_receipts WHERE tenant_id=$1 AND job_id=$2 AND action_key=$3',[row.tenant_id,row.job_id,key]);
        if(!rows.rows.length || !await config.verifyProviderReceipt(request,rows.rows[0]))return null;
        await guard();const result=await config.recoverEvaluation(request,key);if(!await authorizeSources())return refuse();return result;
      },
      async enqueue(key,message){await guard();return config.enqueue(request,key,message,paid);},
    };
  }
  return {
    async bootstrap(credential: unknown, jobId: string) {
      const p=await principal(credential);if(!validId(jobId))return refuse();
      const request=await config.loadRequest(p,jobId), input=await config.policyFor(p.tenantId);
      if(!request || !input || request.tenantId!==p.tenantId || request.job.customerId!==p.tenantId || request.job.jobId!==jobId || !await config.authorizeJob(p,request))return refuse();
      const policy=createAutonomousPolicy(input);if(policy.tenantId!==p.tenantId)return refuse();
      const paidPolicy=await config.paidPolicy(request);
      for(const reservationMicroUsd of [paidPolicy.targetReservationMicroUsd,paidPolicy.judgeReservationMicroUsd]) {
        createAutonomousPaidReservationPolicy({policy,job:request.job,role:'evaluation_engineer',jobCapMicroUsd:paidPolicy.jobCapMicroUsd,reservationMicroUsd});
      }
      const authorityDigest=autonomyDigest({policy,paidPolicy});
      await config.db.query('INSERT INTO company_autonomy_release.job_bindings(tenant_id,job_id,owner_id,policy_version,request,enabled,next_tick_at,authority_digest) VALUES($1,$2,$3,$4,$5::jsonb,true,$6,$7) ON CONFLICT DO NOTHING',[p.tenantId,jobId,p.subject,policy.version,JSON.stringify(request),config.now(),authorityDigest]);
      const row=await binding(p.tenantId,jobId);if(!row || row.owner_id!==p.subject || autonomyDigest(row.request)!==autonomyDigest(request))return refuse();
      await current(row,policy);return {tenantId:p.tenantId,jobId,policyVersion:policy.version,authority:'automated_review' as const};
    },
    async scheduledTick(credential: unknown) {
      if(!await config.authenticateScheduler(credential))return refuse();
      const rows=await config.db.query<Binding>('SELECT tenant_id,job_id,owner_id,policy_version,authority_digest,request,enabled FROM company_autonomy_release.job_bindings WHERE enabled=true AND next_tick_at<=$1 ORDER BY next_tick_at,tenant_id,job_id LIMIT 25',[config.now()]);
      if(rows.rows.length>25)return refuse();
      const outcomes=[];
      for(const row of rows.rows) {
        try {const result=await advanceAutonomousCompany(row.request,await ports(row));outcomes.push({jobId:row.job_id,...result});}
        catch {outcomes.push({jobId:row.job_id,state:'exception',reason:'current_authority_or_adapter_refused'});}
        // Persist fair bounded rescheduling; concurrent ticks still share all durable operation keys.
        await config.db.query('UPDATE company_autonomy_release.job_bindings SET next_tick_at=$3 WHERE tenant_id=$1 AND job_id=$2 AND policy_version=$4',[row.tenant_id,row.job_id,config.now()+60_000,row.policy_version]);
      }
      return {outcomes};
    },
    async publication(credential: unknown, jobId: string) {
      const p=await principal(credential);if(!validId(jobId))return refuse();
      const row=await binding(p.tenantId,jobId);if(!row || row.owner_id!==p.subject)return refuse();
      const port=await ports(row);
      const key=`autonomous-company:${p.tenantId}:${jobId}:${row.request.round}:published-report`;
      const publication=await port.operations.get(key);
      if(!publication || publication.state!=='complete')return null;
      const result=publication.result as {tenantId?:string;jobId?:string;artifactId?:string;rendered?:unknown};
      if(result.tenantId!==p.tenantId || result.jobId!==jobId || !result.artifactId || !result.rendered)return refuse();
      await current(row);return {authority:'automated_review' as const,publication:result};
    },
  };
}
