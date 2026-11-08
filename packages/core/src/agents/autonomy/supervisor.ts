import type { AgentSqlExecutor, AgentTransactionalSql } from '../postgres-ports';
import { autonomyDigest, assertAutonomyId, assertAutonomyInteger, createAutonomousPolicy, type AutonomousPolicy, type AutonomyRole } from './policy';

export type AutonomyActionInput = {
  tenantId: string; key: string; jobId: string; comparison: boolean; role: AutonomyRole;
  agentId: string; agentVersion: number; kind: string; inputDigest: string; reserveMicroUsd: number;
};
export type AutonomyAction = AutonomyActionInput & {
  policyVersion: string; policyDigest: string; periodId: string; identityDigest: string;
  state: 'reserved' | 'dispatched' | 'completed' | 'inconclusive'; token: string;
  createdAt: number; deadline: number; leaseUntil: number; recoveryChecks: number;
  receipt: null | { providerId: string; resultDigest: string; costMicroUsd: number | null };
  reason: string; costStatus: 'unknown' | 'known';
};
export type AutonomyDecision = { key: string; tenantId: string; jobId: string; policyVersion: string;
  authority: 'configured_automated_policy'; reason: string; allowed: boolean; at: number;
  costStatus: 'known' | 'unknown'; costMicroUsd: number | null; inputDigest: string };
export type BeginActionResult = { status: 'acquired' | 'existing'; action: AutonomyAction } | { status: 'denied'; reason: string };
export type ReceiptLookup = (action: Readonly<AutonomyAction>) => Promise<
  { status: 'found'; receipt: NonNullable<AutonomyAction['receipt']> } | { status: 'pending' | 'unavailable' | 'absent' }>;

/** Durable policy authority, not an LLM approver. Supply current authorization on EVERY call.
 * This ledger is an orchestration envelope; do not add its reservation to measured agent costs.
 * Provider adapters MUST use action.key as durable provider idempotency identity. */
export class PostgresAutonomySupervisor {
  readonly policy: AutonomousPolicy;
  constructor(private readonly db: AgentTransactionalSql, policy: AutonomousPolicy,
    private readonly authorize: (tenantId: string, jobId: string) => Promise<boolean>) {
    this.policy = createAutonomousPolicy(policy);
  }
  private async check(tenant: string, job: string) {
    if (tenant !== this.policy.tenantId || !(await this.authorize(tenant, job))) throw new Error('autonomy_unauthorized');
  }
  private async lock(tx: AgentSqlExecutor) {
    const p = this.policy;
    await tx.query('INSERT INTO company_autonomy.periods(tenant_id,period_id,root_cap) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [p.tenantId,p.periodId,p.rootBudgetMicroUsd]);
    const root = (await tx.query<{root_cap: string | number}>('SELECT root_cap FROM company_autonomy.periods WHERE tenant_id=$1 AND period_id=$2 FOR UPDATE', [p.tenantId,p.periodId])).rows[0];
    if (Number(root?.root_cap) !== p.rootBudgetMicroUsd) throw new Error('autonomy_root_budget_immutable');
    const digest = autonomyDigest(p);
    await tx.query('INSERT INTO company_autonomy.policies(tenant_id,version,digest,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING', [p.tenantId,p.version,digest,JSON.stringify(p)]);
    const saved = (await tx.query<{digest:string}>('SELECT digest FROM company_autonomy.policies WHERE tenant_id=$1 AND version=$2',[p.tenantId,p.version])).rows[0];
    if (saved?.digest !== digest) throw new Error('autonomy_policy_version_conflict');
  }
  private async audit(tx: AgentSqlExecutor, d: AutonomyDecision) {
    // Decision identity includes outcome: an exhausted decision is immutable evidence even when
    // the same action is later admitted after a known settlement frees reservations.
    const { at: _firstWriteTimestamp, ...identity } = d;
    const key = `${d.key}:${autonomyDigest(identity)}`;
    await tx.query('INSERT INTO company_autonomy.decisions(tenant_id,decision_key,record) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[d.tenantId,key,JSON.stringify(d)]);
  }
  private async save(tx: AgentSqlExecutor, a: AutonomyAction, held: number) {
    await tx.query('UPDATE company_autonomy.actions SET record=$3::jsonb,held=$4 WHERE tenant_id=$1 AND action_key=$2',[a.tenantId,a.key,JSON.stringify(a),held]);
  }
  async begin(input: AutonomyActionInput, workerToken: string, now: number): Promise<BeginActionResult> {
    input = structuredClone(input); assertAutonomyId(workerToken); assertAutonomyInteger(now);
    for (const s of [input.tenantId,input.key,input.jobId,input.agentId,input.kind]) assertAutonomyId(s);
    assertAutonomyInteger(input.reserveMicroUsd); assertAutonomyInteger(input.agentVersion,1);
    if (!/^[a-f0-9]{64}$/.test(input.inputDigest) || typeof input.comparison !== 'boolean') throw new Error('invalid_autonomy_input');
    await this.check(input.tenantId,input.jobId);
    const p = this.policy; const configured = p.agents[input.role];
    const invalidAuthority = !configured || configured.id !== input.agentId || configured.version !== input.agentVersion || !p.allowedActions.includes(input.kind);
    return this.db.transaction(async tx => {
      await this.lock(tx);
      const identityDigest = autonomyDigest(input);
      const decision = (reason:string,allowed:boolean): AutonomyDecision => ({key:input.key,tenantId:input.tenantId,jobId:input.jobId,policyVersion:p.version,authority:'configured_automated_policy',reason,allowed,at:now,costStatus:'unknown',costMicroUsd:null,inputDigest:input.inputDigest});
      if (invalidAuthority) { await this.audit(tx,decision('action_or_exact_agent_not_authorized',false)); return {status:'denied',reason:'action_or_exact_agent_not_authorized'}; }
      const existing = (await tx.query<{record:AutonomyAction}>('SELECT record FROM company_autonomy.actions WHERE tenant_id=$1 AND action_key=$2',[input.tenantId,input.key])).rows[0]?.record;
      if (existing) {
        if (existing.identityDigest !== identityDigest || existing.policyDigest !== autonomyDigest(p)) throw new Error('autonomy_action_identity_conflict');
        if (existing.state === 'reserved' && existing.leaseUntil <= now && existing.deadline > now) {
          existing.token = workerToken; existing.leaseUntil = Math.min(now + p.leaseMs,existing.deadline);
          existing.reason = 'safe_undispatched_reclaim'; await this.save(tx,existing,input.reserveMicroUsd);
          await this.audit(tx,decision(existing.reason,true)); return {status:'acquired',action:existing};
        }
        return {status:'existing',action:existing};
      }
      const cap = input.comparison ? p.comparisonJobCapMicroUsd : p.singleJobCapMicroUsd;
      await tx.query('INSERT INTO company_autonomy.jobs(tenant_id,job_id,comparison,cap) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[p.tenantId,input.jobId,input.comparison,cap]);
      const job = (await tx.query<{comparison:boolean;cap:string}>('SELECT comparison,cap FROM company_autonomy.jobs WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE',[p.tenantId,input.jobId])).rows[0];
      if(job.comparison !== input.comparison || Number(job.cap) !== cap) throw new Error('autonomy_job_budget_immutable');
      const totals = (await tx.query<{root:string;job:string;role:string}>(`SELECT
        COALESCE(SUM(CASE WHEN period_id=$2 THEN held ELSE 0 END),0) AS root,
        COALESCE(SUM(CASE WHEN job_id=$3 THEN held ELSE 0 END),0) AS job,
        COALESCE(SUM(CASE WHEN role=$4 AND period_id=$2 THEN held ELSE 0 END),0) AS role
        FROM company_autonomy.actions WHERE tenant_id=$1`,[p.tenantId,p.periodId,input.jobId,input.role])).rows[0];
      const n = input.reserveMicroUsd;
      if (Number(totals.root)+n > p.rootBudgetMicroUsd || Number(totals.job)+n > cap || Number(totals.role)+n > p.roleCapsMicroUsd[input.role]) {
        await this.audit(tx,decision('budget_exhausted',false)); return {status:'denied',reason:'budget_exhausted'};
      }
      const action: AutonomyAction = {...input,policyVersion:p.version,policyDigest:autonomyDigest(p),periodId:p.periodId,identityDigest,
        state:'reserved',token:workerToken,createdAt:now,deadline:now+p.actionDeadlineMs,leaseUntil:now+p.leaseMs,recoveryChecks:0,
        receipt:null,reason:'bounded_policy_authorized',costStatus:'unknown'};
      await tx.query('INSERT INTO company_autonomy.actions(tenant_id,action_key,period_id,job_id,role,held,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[p.tenantId,input.key,p.periodId,input.jobId,input.role,n,JSON.stringify(action)]);
      await this.audit(tx,decision(action.reason,true)); return {status:'acquired',action};
    });
  }
  /** Authorize an existing durable AgentTaskRunner without reserving its budget twice.
   * The runner remains responsible for atomic job/role reservations and exact version checks. */
  async authorizeDecision(input: Omit<AutonomyActionInput, 'reserveMicroUsd' | 'comparison'>, now:number):Promise<{allowed:boolean;reason:string}> {
    input=structuredClone(input); assertAutonomyInteger(now);
    for(const value of [input.key,input.jobId,input.tenantId,input.kind,input.agentId]) assertAutonomyId(value);
    if(!/^[a-f0-9]{64}$/.test(input.inputDigest)) throw new Error('invalid_autonomy_input');
    await this.check(input.tenantId,input.jobId);
    const agent=this.policy.agents[input.role];
    const allowed=!!agent && agent.id===input.agentId && agent.version===input.agentVersion && this.policy.allowedActions.includes(input.kind);
    const reason=allowed?'bounded_policy_authorized':'action_or_exact_agent_not_authorized';
    await this.db.transaction(async tx => { await this.lock(tx); await this.audit(tx,{key:input.key,tenantId:input.tenantId,jobId:input.jobId,
      policyVersion:this.policy.version,authority:'configured_automated_policy',reason,allowed,at:now,costStatus:'unknown',costMicroUsd:null,inputDigest:input.inputDigest}); });
    return {allowed,reason};
  }
  async get(key:string): Promise<AutonomyAction | null> {
    assertAutonomyId(key);
    const a = (await this.db.query<{record:AutonomyAction}>('SELECT record FROM company_autonomy.actions WHERE tenant_id=$1 AND action_key=$2',[this.policy.tenantId,key])).rows[0]?.record ?? null;
    if (a) await this.check(a.tenantId,a.jobId);
    return a;
  }
  async markDispatched(key:string,token:string,now:number):Promise<AutonomyAction> {
    return this.mutate(key,async(tx,a) => {
      if (a.state !== 'reserved' || a.token !== token || a.leaseUntil <= now || a.deadline <= now) throw new Error('autonomy_dispatch_lease_invalid');
      a.state='dispatched'; a.reason='dispatch_intent_persisted'; await this.save(tx,a,a.reserveMicroUsd); return a;
    });
  }
  private async mutate<T>(key:string,fn:(tx:AgentSqlExecutor,a:AutonomyAction)=>Promise<T>):Promise<T> {
    const existing = await this.get(key); if (!existing) throw new Error('autonomy_action_missing');
    return this.db.transaction(async tx => {
      await this.lock(tx);
      const a = (await tx.query<{record:AutonomyAction}>('SELECT record FROM company_autonomy.actions WHERE tenant_id=$1 AND action_key=$2 FOR UPDATE',[this.policy.tenantId,key])).rows[0]?.record;
      if (!a) throw new Error('autonomy_action_missing');
      return fn(tx,a);
    });
  }
  async complete(key:string,token:string,receipt:NonNullable<AutonomyAction['receipt']>,now:number):Promise<AutonomyAction> {
    receipt=structuredClone(receipt); assertAutonomyId(receipt.providerId); assertAutonomyInteger(now);
    if (!/^[a-f0-9]{64}$/.test(receipt.resultDigest)) throw new Error('invalid_autonomy_receipt');
    if (receipt.costMicroUsd !== null) assertAutonomyInteger(receipt.costMicroUsd);
    return this.mutate(key,async(tx,a) => {
      if (a.state === 'completed') { if (autonomyDigest(a.receipt) !== autonomyDigest(receipt)) throw new Error('autonomy_receipt_conflict'); return a; }
      if (a.token !== token || a.state !== 'dispatched') throw new Error('autonomy_completion_lease_invalid');
      a.receipt=receipt; a.state='completed'; a.reason=receipt.costMicroUsd === null?'completed_cost_unknown':'completed_authoritative_receipt';
      a.costStatus=receipt.costMicroUsd === null?'unknown':'known';
      await this.save(tx,a,receipt.costMicroUsd ?? a.reserveMicroUsd);
      await this.audit(tx,{key:a.key,tenantId:a.tenantId,jobId:a.jobId,policyVersion:a.policyVersion,authority:'configured_automated_policy',reason:a.reason,allowed:true,at:now,costStatus:a.costStatus,costMicroUsd:receipt.costMicroUsd,inputDigest:a.inputDigest}); return a;
    });
  }
  /** Called periodically by host Cron. Never invokes a paid action. Ambiguous dispatch is
   * queried by authoritative receipt only; even an absent receipt does not authorize replay. */
  async recoverDue(now:number,lookup:ReceiptLookup,limit=25):Promise<AutonomyAction[]> {
    assertAutonomyInteger(now); assertAutonomyInteger(limit,1); if(limit>100) throw new Error('autonomy_recovery_limit');
    const rows=await this.db.query<{record:AutonomyAction}>(`SELECT record FROM company_autonomy.actions WHERE tenant_id=$1 AND period_id=$2
      AND record->>'state' IN ('reserved','dispatched') AND (record->>'leaseUntil')::bigint <= $3 ORDER BY action_key LIMIT $4`,[this.policy.tenantId,this.policy.periodId,now,limit]);
    const results:AutonomyAction[]=[];
    for(const row of rows.rows) {
      const a=row.record; await this.check(a.tenantId,a.jobId);
      // Claim a recovery lease before the provider query, so concurrent Cron invocations cannot
      // perform unbounded receipt checks. The query itself must use a bounded transport timeout.
      const claimed=await this.mutate(a.key,async(tx,current) => {
        if(current.state==='completed'||current.state==='inconclusive'||current.leaseUntil>now) return null;
        if(current.state==='reserved' && current.deadline>now) return null; // next begin safely reclaims
        current.recoveryChecks++; current.leaseUntil=now+this.policy.leaseMs;
        await this.save(tx,current,current.reserveMicroUsd); return current;
      });
      if(!claimed) continue;
      let found:Awaited<ReturnType<ReceiptLookup>>={status:'unavailable'};
      if(claimed.state==='dispatched') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Lookup is read-only. Its timeout never grants authority to replay the paid action.
          found=await Promise.race([lookup(structuredClone(claimed)), new Promise<{status:'unavailable'}>(resolve=>{
            timer=setTimeout(()=>resolve({status:'unavailable'}),Math.min(this.policy.leaseMs,30_000));
          })]);
        } catch { /* receipt unavailable */ } finally { if(timer !== undefined) clearTimeout(timer); }
      }
      if(found.status==='found') { results.push(await this.complete(claimed.key,claimed.token,found.receipt,now)); continue; }
      results.push(await this.mutate(claimed.key,async(tx,current) => {
        if(current.state==='completed'||current.state==='inconclusive') return current;
        const stop=current.deadline<=now || current.recoveryChecks>=this.policy.maxRecoveryChecks || found.status==='unavailable';
        current.reason=stop ? (current.state==='reserved'?'undispatched_deadline_expired':'ambiguous_dispatch_inconclusive'):'awaiting_authoritative_receipt';
        if(stop) current.state='inconclusive';
        // No dispatch ever occurred: release the reservation. Ambiguous paid dispatch holds it.
        const held=claimed.state==='reserved'?0:current.reserveMicroUsd;
        if(claimed.state==='reserved') current.costStatus='known';
        await this.save(tx,current,held);
        await this.audit(tx,{key:current.key,tenantId:current.tenantId,jobId:current.jobId,policyVersion:current.policyVersion,authority:'configured_automated_policy',reason:current.reason,allowed:false,at:now,costStatus:current.costStatus,costMicroUsd:claimed.state==='reserved'?0:null,inputDigest:current.inputDigest}); return current;
      }));
    }
    return results;
  }
  async dailyAudit(day:string):Promise<AutonomyDecision[]> {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('invalid_autonomy_audit_day');
    const rows=await this.db.query<{record:AutonomyDecision}>('SELECT record FROM company_autonomy.decisions WHERE tenant_id=$1 ORDER BY decision_key',[this.policy.tenantId]);
    const out:AutonomyDecision[]=[];
    for(const {record} of rows.rows) if(new Date(record.at).toISOString().slice(0,10)===day) { await this.check(record.tenantId,record.jobId); out.push(record); }
    const summary={day,policyVersion:this.policy.version,authority:'configured_automated_policy',decisions:out};
    await this.db.query(`INSERT INTO company_autonomy.daily_audits(tenant_id,day,digest,record) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(tenant_id,day) DO UPDATE SET digest=EXCLUDED.digest,record=EXCLUDED.record`,[this.policy.tenantId,day,autonomyDigest(summary),JSON.stringify(summary)]);
    return out;
  }
}
