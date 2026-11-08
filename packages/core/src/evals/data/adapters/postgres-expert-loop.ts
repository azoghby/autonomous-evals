import { z } from 'zod';
import type { AgentSqlExecutor, AgentTransactionalSql } from '../../../agents/postgres-ports';
import type { BudgetLedger } from '../../types';
import { reviewDigest } from '../binding';
import { inspectDataSafety } from '../quality';
import { AUTOMATED_EXPERT_PILOT_LIMITS, type AutomatedExpertOwnerPorts, type ExpertLoopRecord, type ExpertLoopScope, type ExpertLoopStore } from './automated-expert';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const scopeSchema = z.object({ jobId: id, taskId: id, operationId: z.string().regex(/^expert:[a-f0-9]{64}$/), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const invitationSchema = z.object({ requestId: z.string(), contactId: id, questions: z.array(z.string().min(1).max(10000)).min(1).max(100), requiredUses: z.array(z.string().min(1).max(100)).min(1).max(20), honorariumMicroUsd: z.number().int().min(0).max(AUTOMATED_EXPERT_PILOT_LIMITS.jobMicroUsd), sharesCustomerScope: z.boolean() }).strict();
const recordSchema = z.object({ scope: scopeSchema, revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), state: z.enum(['selecting','selected','dispatching','sent']), invitation: invitationSchema.optional(), deliveryId: id.optional() }).strict();
const denied = (): never => { throw Error('expert_persistence_denied_or_conflict'); };
export interface ExpertSqlAuthority {
  tenantId: string;
  scope: ExpertLoopScope;
  /** Trusted current owner policy, using transaction-visible rows. Never a model/external call. */
  authorize(tx: AgentSqlExecutor, scope: ExpertLoopScope & { tenantId: string }): Promise<{ allowed: boolean; knownSecrets: readonly string[] }>;
}

/** Bound to one tenant/job/task/request. Existing text checkpoint schema, no automatic migrations.
 * Raw contact details never enter this store; contactId/deliveryId are opaque owner-issued IDs. */
export function createPostgresExpertLoopStore(sql: AgentTransactionalSql, options: ExpertSqlAuthority): ExpertLoopStore {
  const tenantId = id.parse(options.tenantId), scope = scopeSchema.parse(structuredClone(options.scope));
  const kind = `expert_loop:${tenantId}:${scope.taskId}`;
  const digest = reviewDigest({tenantId,scope});
  function valid(raw: unknown): ExpertLoopRecord {
    const row = recordSchema.parse(structuredClone(raw));
    if (reviewDigest(row.scope) !== reviewDigest(scope) ||
      (row.state === 'selecting' ? row.invitation !== undefined || row.deliveryId !== undefined : !row.invitation || row.invitation.requestId !== scope.operationId) ||
      (row.state === 'sent' ? !row.deliveryId : row.deliveryId !== undefined) ||
      Buffer.byteLength(JSON.stringify(row)) > 500000) denied();
    return row;
  }
  async function authorize(tx: AgentSqlExecutor, value: unknown) {
    const policy = await options.authorize(tx,structuredClone({...scope,tenantId}));
    if (!policy.allowed || !Array.isArray(policy.knownSecrets) || policy.knownSecrets.some(s=>typeof s!=='string'||s.length<4) || !inspectDataSafety(value,policy.knownSecrets).safe) denied();
  }
  async function read(tx: AgentSqlExecutor): Promise<ExpertLoopRecord|null> {
    const row = (await tx.query<{input_digest:string;token:string;state:string;value:unknown}>('SELECT input_digest,token,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR UPDATE',[scope.jobId,kind,scope.operationId])).rows[0];
    if (!row) return null;
    const record = valid(row.value);
    if(row.input_digest!==digest||row.state!=='completed'||row.token!==String(record.revision)) denied();
    return record;
  }
  function operation(value:string) { if(value!==scope.operationId)denied(); }
  return {
    async get(operationId) {
      operation(operationId);
      return sql.transaction(async tx=>{await authorize(tx,scope);const row=await read(tx);await authorize(tx,row);return structuredClone(row);});
    },
    async insertIfAbsent(raw) {
      const value=valid(raw);if(value.revision!==0||value.state!=='selecting')denied();
      return sql.transaction(async tx=>{
        await authorize(tx,value);
        await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,$2,$3,$4,'0','completed',$5::jsonb) ON CONFLICT DO NOTHING`,[scope.jobId,kind,scope.operationId,digest,JSON.stringify(value)]);
        const row=await read(tx);if(!row) return denied();await authorize(tx,row);return structuredClone(row);
      });
    },
    async compareAndSet(operationId,revision,raw) {
      operation(operationId);const next=valid(raw);
      if(!Number.isSafeInteger(revision)||revision<0||next.revision!==revision+1)denied();
      return sql.transaction(async tx=>{
        await authorize(tx,next);const current=await read(tx);
        if(!current||current.revision!==revision){await authorize(tx,current);return null;}
        const transitions={selecting:'selected',selected:'dispatching',dispatching:'sent',sent:null};
        if(transitions[current.state]!==next.state || (current.invitation&&reviewDigest(current.invitation)!==reviewDigest(next.invitation)))denied();
        await tx.query('UPDATE text_integration.checkpoints SET token=$1,value=$2::jsonb WHERE job_id=$3 AND kind=$4 AND id=$5',[String(next.revision),JSON.stringify(next),scope.jobId,kind,scope.operationId]);
        await authorize(tx,next);return structuredClone(next);
      });
    },
  };
}

/** Separate honorarium promises, not eval-agent inference budgets. Holds remain until an explicit
 * owner reconciliation settles/releases them; this adapter never releases an ambiguous send. */
export function createExpertPromiseReservation(ledger: BudgetLedger, authority: {
  /** Owner retains this day from the first authorized promise; never use today's date on replay. */
  dayScope: string;
  authorize(scope: ExpertLoopScope): Promise<{ allowed: boolean; policyId: string; dayScope: string }>;
}): AutomatedExpertOwnerPorts['reserve'] {
  const dayScope=authority.dayScope;
  return async (rawScope,rawInput)=>{
    const scope=scopeSchema.parse(structuredClone(rawScope)),input=structuredClone(rawInput);
    const auth=await authority.authorize(structuredClone(scope));
    if(!auth.allowed||auth.policyId!==input.policyId||auth.dayScope!==input.dayScope||dayScope!==input.dayScope||!/^\d{4}-\d{2}-\d{2}$/.test(input.dayScope)||
      !/^expert-invite:[a-f0-9]{64}$/.test(input.key)||!id.safeParse(input.contactId).success||!id.safeParse(input.policyId).success||
      !Number.isSafeInteger(input.amountMicroUsd)||input.amountMicroUsd<0||input.amountMicroUsd>AUTOMATED_EXPERT_PILOT_LIMITS.jobMicroUsd||
      input.jobCapMicroUsd!==AUTOMATED_EXPERT_PILOT_LIMITS.jobMicroUsd||input.dailyCapMicroUsd!==AUTOMATED_EXPERT_PILOT_LIMITS.dailyMicroUsd)denied();
    // The caller must persist the immutable selected invitation before reserving. A free
    // invitation is durable there; it creates no monetary reservation (ledger amounts are positive).
    if(input.amountMicroUsd===0){
      const after=await authority.authorize(structuredClone(scope));
      if(!after.allowed||after.policyId!==auth.policyId||after.dayScope!==auth.dayScope)denied();
      return true;
    }
    // Operation and contact identify the promise; its scope list durably binds the first day.
    // The owner must retain that day for replay; changing days cannot reserve another promise.
    const reservationId=`expert-promise:${reviewDigest({scope,key:input.key,contactId:input.contactId})}`;
    const result=await ledger.reserve({reservationId,jobId:scope.jobId,amountMicroUsd:input.amountMicroUsd,scopes:[
      {key:`expert-job:${scope.jobId}`,capMicroUsd:input.jobCapMicroUsd},
      {key:`expert-company-day:${input.dayScope}`,capMicroUsd:input.dailyCapMicroUsd},
    ]});
    const after=await authority.authorize(structuredClone(scope));
    if(!after.allowed||after.policyId!==auth.policyId||after.dayScope!==auth.dayScope)denied();
    return result.ok;
  };
}
