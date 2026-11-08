import 'server-only';
import type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { IntakeInput } from '@ae/core/contracts/index';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { FactualGapProposalSchema, factualGapInputDigest, type FactualGapProposal } from '@ae/core/evals/text/factual-gap';
import { normalizeReferenceText } from '@ae/core/evals/text/schema';
import { decryptJson } from '@ae/core/storage/crypto';
import { credentialSlotsOf, injectCredentials } from '@/server/intake';
import type { ProductionDataInput } from '@/server/expert-data-production';

export interface FactualGapPlanRequest {
  jobId: string;
  environment: 'test' | 'live';
  /** Owner-assigned expert scope and generic design version; never model assigned. */
  taskId: string;
  versionLabel: string;
  proposal: FactualGapProposal;
  canonicalInputDigest: string; expectedTargetDigest?: string;
}
export type FactualGapPlanResult =
  | { status: 'installed' | 'replayed'; inputDigest: string; proposalDigest: string; contactGate: 'opted_in' | 'cold_approval_required' }
  | { status: 'prerequisite_blocked'; reason: 'real_mode' | 'job_scope' | 'owner_scope' | 'owner_policy' | 'sharing_consent' | 'expert_qualification' | 'credentials' | 'deadline' }
  | { status: 'rejected'; reason: 'invalid_proposal' | 'input_binding' | 'unsafe_input' | 'plan_conflict' };
interface Job { customer_id: string; environment: 'test' | 'live'; package: string; is_mock: boolean; state: string; intake: unknown; response_deadline: Date | string; before_deadline: boolean; credentials_current: boolean }
export type FactualGapProductionInput = ProductionDataInput & {
  factualGapEntry: { schemaVersion: 'factual_gap_plan.v1'; proposal: FactualGapProposal; proposalDigest: string;
    canonicalInputDigest: string; expectedTargetDigest?: string; targetDigest: string; environment: 'test' | 'live'; tenantId: string };
};
const blocked = (reason: Extract<FactualGapPlanResult,{status:'prerequisite_blocked'}>['reason']): FactualGapPlanResult => ({ status: 'prerequisite_blocked', reason });
const rejected = (reason: Extract<FactualGapPlanResult,{status:'rejected'}>['reason']): FactualGapPlanResult => ({ status: 'rejected', reason });

/** Pure candidate for trusted owner configuration. Its exact task/topic hash must already
 * be authorized in expert_automation_scopes. Calling this does not approve the proposal. */
export function deriveFactualGapPlan(request: FactualGapPlanRequest, job: Pick<Job,'customer_id'|'intake'>, securedTargetVersion: string): FactualGapProductionInput {
  const proposal = FactualGapProposalSchema.parse(request.proposal);
  if (!/^[a-f0-9]{64}$/.test(securedTargetVersion) || request.expectedTargetDigest !== undefined && request.expectedTargetDigest !== securedTargetVersion) throw Error('input_binding');
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(request.taskId) || !request.versionLabel.trim() || request.versionLabel.length > 64) throw Error('invalid_proposal');
  const parsed = IntakeInput.parse(job.intake);
  if (parsed.package !== 'text_eval' || !parsed.authorizedToTest || normalizeReferenceText(parsed.endpoint.referenceText ?? null) !== null) throw Error('input_binding');
  const canonical = { package: parsed.package, authorizedToTest: parsed.authorizedToTest, endpoint: {
    url: parsed.endpoint.url, model: parsed.endpoint.model, systemPrompt: parsed.endpoint.systemPrompt,
    referenceText: normalizeReferenceText(parsed.endpoint.referenceText ?? null),
  }, notes: parsed.notes ?? null };
  if (reviewDigest(canonical) !== request.canonicalInputDigest || proposal.inputDigest !== factualGapInputDigest({
    job: { jobId: request.jobId, customerId: job.customer_id, environment: request.environment }, versionLabel: request.versionLabel,
    systemPrompt: parsed.endpoint.systemPrompt, referenceText: null })) throw Error('input_binding');
  if (new Set(proposal.requirements.map(r => r.check.id)).size !== proposal.requirements.length || proposal.requirements.some(r =>
    !r.check.id.startsWith(`${r.scenarioId}.`) || !r.check.assessesFactualCorrectness || !r.check.requiresReference || r.check.conditionalInstructionId !== undefined || r.check.behavioralInstructionId !== undefined)) throw Error('invalid_proposal');
  const proposalDigest = reviewDigest(proposal), targetDigest = securedTargetVersion;
  const entry = { schemaVersion: 'factual_gap_plan.v1' as const, proposal, proposalDigest, canonicalInputDigest: request.canonicalInputDigest,
    targetDigest, environment: request.environment, tenantId: job.customer_id };
  return { task: { taskId: request.taskId, jobId: request.jobId, targetId: `target:${targetDigest}`,
    description: `Owner-validated proposed factual coverage ${reviewDigest({ entry, versionLabel: request.versionLabel })}`,
    factualAnswersRequired: true, requiredUses: ['evaluation'], requirements: proposal.requirements.map(r => ({
      id: r.check.id, description: `${r.userMessage}\n${r.check.rubric}`, minimumCases: 1 })) },
    initial: { sources: [], cases: [] }, context: { versionLabel: request.versionLabel, systemPrompt: parsed.endpoint.systemPrompt }, factualGapEntry: entry };
}

/** Private Workflow seam. Installs only an already configured exact owner scope. No provider,
 * invitation, promise, review or new Workflow is dispatched. The existing expert gate advances it. */
export async function installFactualGapExpertPlan(request: FactualGapPlanRequest, deps: {
  sql?: AgentTransactionalSql;
  decryptCredentials?: (ciphertext: string) => Record<string,string>;
} = {}): Promise<FactualGapPlanResult> {
  request = structuredClone(request);
  if (process.env.EVAL_SERVICES !== 'real') return blocked('real_mode');
  if (!/^[0-9a-f-]{36}$/i.test(request.jobId) || !['test','live'].includes(request.environment) || !/^[a-f0-9]{64}$/.test(request.canonicalInputDigest) || !FactualGapProposalSchema.safeParse(request.proposal).success) return rejected('invalid_proposal');
  const sql = deps.sql ?? (await import('@/server/automated-expert-owner')).expertOwnerDatabase();
  const decrypt = deps.decryptCredentials ?? decryptJson<Record<string,string>>;
  async function resolve(tx: AgentSqlExecutor, lock = false) {
    const row = (await tx.query<Job>(`SELECT customer_id::text,environment,package,is_mock,state,intake,
      created_at+interval '7 days' AS response_deadline,created_at+interval '7 days'>now() AS before_deadline,
      (credentials_delete_after IS NULL OR credentials_delete_after>now()) AS credentials_current
      FROM jobs WHERE id=$1${lock?' FOR UPDATE':''}`, [request.jobId])).rows[0];
    if (!row || row.environment !== request.environment || row.package !== 'text_eval' || row.is_mock || !['planning','running','investigating'].includes(row.state)) return blocked('job_scope');
    if (!row.before_deadline) return blocked('deadline');
    if (!row.credentials_current) return blocked('credentials');
    if (!row.intake || typeof row.intake !== 'object' || Array.isArray(row.intake)) return rejected('input_binding');
    const raw = row.intake as Record<string,unknown>;
    for (const slot of ['endpoint','endpointA','endpointB']) {
      const endpoint = raw[slot];
      if (endpoint && typeof endpoint === 'object' && 'apiKey' in endpoint) return rejected('unsafe_input');
    }
    if (raw._credentialSlots !== undefined && (!Array.isArray(raw._credentialSlots) || raw._credentialSlots.some(slot => slot !== 'endpoint'))) return blocked('credentials');
    const credential = (await tx.query<{ciphertext:string}>(`SELECT ciphertext FROM job_credentials WHERE job_id=$1${lock?' FOR UPDATE':''}`,[request.jobId])).rows[0];
    let values: Record<string,string>;
    try { values = credential ? decrypt(credential.ciphertext) : {}; } catch { return rejected('unsafe_input'); }
    if (!values || typeof values !== 'object' || Object.values(values).some(v => typeof v !== 'string')) return rejected('unsafe_input');
    if (credentialSlotsOf(raw).some(slot => !values[slot])) return blocked('credentials');
    const endpoint = injectCredentials(raw,values).endpoint as {url?:unknown;model?:unknown;apiKey?:unknown;systemPrompt?:unknown}|undefined;
    if (!endpoint || typeof endpoint.url !== 'string' || typeof endpoint.model !== 'string' || endpoint.apiKey !== undefined && typeof endpoint.apiKey !== 'string') return rejected('input_binding');
    const target = { url: endpoint.url, model: endpoint.model, ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}), systemPrompt: endpoint.systemPrompt ?? '' };
    let input: FactualGapProductionInput;
    try { input = deriveFactualGapPlan(request,row,reviewDigest(target)); } catch (e) { return rejected(e instanceof Error && e.message === 'input_binding' ? 'input_binding' : 'invalid_proposal'); }
    const secrets = [...Object.values(values),...Object.entries(process.env).filter(([k])=>/(?:KEY|TOKEN|SECRET|DATABASE_URL)$/.test(k)).map(([,v])=>v??'')].filter(Boolean);
    if (!inspectDataSafety(input,secrets).safe) return rejected('unsafe_input');
    return { row, input, secrets };
  }
  const initial = await resolve(sql);
  if ('status' in initial) return initial;
  return sql.transaction(async tx => {
    // Reload canonical identity and credentials under locks immediately before authority/write.
    const fresh = await resolve(tx,true);
    if ('status' in fresh) return fresh;
    if (reviewDigest(fresh.input) !== reviewDigest(initial.input)) return rejected('input_binding');
    const scope = (await tx.query<{tenant_id:string;request_hash:string;policy_id:string;topic:string;enabled:boolean;customer_sharing_consent:boolean}>(
      'SELECT tenant_id::text,request_hash,policy_id,topic,enabled,customer_sharing_consent FROM expert_automation_scopes WHERE job_id=$1 AND task_id=$2 FOR UPDATE', [request.jobId,request.taskId])).rows[0];
    if (!scope || !scope.enabled || scope.tenant_id !== fresh.row.customer_id || !scope.topic.trim() || scope.topic.length > 160 || scope.request_hash !== reviewDigest({task:fresh.input.task,topic:scope.topic})) return blocked('owner_scope');
    const policy = (await tx.query<{enabled:boolean;job_cap_micro_usd:string;daily_cap_micro_usd:string}>(
      'SELECT enabled,job_cap_micro_usd::text,daily_cap_micro_usd::text FROM expert_automation_policies WHERE id=$1 FOR UPDATE',[scope.policy_id])).rows[0];
    if (!policy?.enabled || policy.job_cap_micro_usd !== '25000000' || policy.daily_cap_micro_usd !== '50000000') return blocked('owner_policy');
    if (scope.customer_sharing_consent !== true) return blocked('sharing_consent');
    const experts = await tx.query<{id:string;source:string;consent_flags:{contactForPaidWork?:boolean}}>(`SELECT e.id,e.source,e.consent_flags FROM experts e JOIN expert_automation_qualifications q ON q.expert_id=e.id
      WHERE q.topic=$1 AND q.qualified AND CASE WHEN jsonb_typeof(q.evidence)='array' THEN jsonb_array_length(q.evidence)>0 ELSE false END
      AND length(q.consent_receipt)>0 AND q.allowed_uses @> '["evaluation"]'::jsonb AND e.status='active'
      AND NOT EXISTS(SELECT 1 FROM contact_suppressions x WHERE lower(x.email)=lower(e.email))
      ORDER BY (e.source='opt_in' AND e.consent_flags->>'contactForPaidWork'='true') DESC,e.id LIMIT 10 FOR UPDATE OF e,q`,[scope.topic]);
    if (!experts.rows.length) return blocked('expert_qualification');
    // Existing discovery queues non-opted contacts for founder approval. A plan never grants it.
    const contactGate = experts.rows.some(e => e.source === 'opt_in' && e.consent_flags?.contactForPaidWork === true) ? 'opted_in' as const : 'cold_approval_required' as const;
    if (process.env.EVAL_SERVICES !== 'real' || !inspectDataSafety({input:fresh.input,topic:scope.topic},fresh.secrets).safe) return rejected('unsafe_input');
    const digest = reviewDigest(fresh.input),deadline = new Date(fresh.row.response_deadline).toISOString();
    const inserted = await tx.query(`INSERT INTO expert_workflow.plans(job_id,tenant_id,input,input_digest,topic,enabled,response_deadline)
      VALUES($1,$2,$3::jsonb,$4,$5,true,$6) ON CONFLICT DO NOTHING RETURNING job_id`,[request.jobId,fresh.row.customer_id,JSON.stringify(fresh.input),digest,scope.topic,deadline]);
    const retained = (await tx.query<{tenant_id:string;input:unknown;input_digest:string;topic:string;enabled:boolean;response_deadline:Date|string}>(
      'SELECT tenant_id::text,input,input_digest,topic,enabled,response_deadline FROM expert_workflow.plans WHERE job_id=$1 FOR UPDATE',[request.jobId])).rows[0];
    if (!retained || retained.tenant_id !== fresh.row.customer_id || retained.input_digest !== digest || reviewDigest(retained.input) !== digest || retained.topic !== scope.topic || new Date(retained.response_deadline).toISOString() !== deadline) return rejected('plan_conflict');
    // Revoked plans are never re-enabled by replay.
    if (!retained.enabled) return blocked('owner_scope');
    return { status: inserted.rows.length ? 'installed' : 'replayed', inputDigest: digest, proposalDigest: fresh.input.factualGapEntry.proposalDigest, contactGate };
  });
}
