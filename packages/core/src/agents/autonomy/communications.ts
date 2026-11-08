import { createHash, randomUUID } from 'node:crypto';
import type { AgentTransactionalSql } from '../postgres-ports';
import { PRICE_TABLE, priceLabel } from '../../evals/pricing';

/** Apply explicitly in application storage. No constructor performs migrations or network I/O. */
export const AUTONOMY_COMMUNICATIONS_SQL = `
CREATE SCHEMA IF NOT EXISTS company_autonomy;
CREATE TABLE IF NOT EXISTS company_autonomy.message_days (
 tenant_id text NOT NULL, day text NOT NULL, reserved integer NOT NULL DEFAULT 0,
 PRIMARY KEY (tenant_id, day));
CREATE TABLE IF NOT EXISTS company_autonomy.messages (
 id text PRIMARY KEY, identity text NOT NULL, tenant_id text NOT NULL, day text NOT NULL,
 record jsonb NOT NULL, state text NOT NULL, deadline bigint NOT NULL, claim_token text);
`;
export type NotificationTemplate = 'clarification' | 'quote' | 'report_ready' | 'monitoring_offer' | 'expert_request';
export interface CommunicationPolicy {
 version: string; mode: 'manual' | 'autonomous.v1'; tenantId: string; sender: string;
 dailyCap: number; maxDispatchAttempts: number; dispatchTimeoutMs: number; deliveryDeadlineMs: number;
 enabledTemplates: readonly NotificationTemplate[]; approvedExpertContactIds: readonly string[];
 reportOrigin: string;
}
export interface CommunicationRequest {
 id: string; tenantId: string; jobId: string; contactId: string; template: NotificationTemplate;
 /** Server-owned frozen quote package. No free-form model claims or prices are accepted. */
 packageId?: 'trace_audit' | 'text_eval' | 'workflow_eval' | 'version_comparison';
 reportId?: string;
}
export interface ContactAuthorization {
 tenantId: string; jobId: string; email: string; active: boolean; optedOut: boolean;
 productNotifications: boolean; marketingOptIn: boolean; expertConsent: boolean;
}
/** Implement at the authenticated server boundary; never obtain these records from an agent/customer payload. */
export interface CommunicationGuards {
 resolveContact(tenantId: string, jobId: string, contactId: string): Promise<ContactAuthorization | null>;
 currentPolicyVersion(tenantId: string): Promise<string>;
 /** Verify persisted job state: report belongs to job and is published, quote package/scope is frozen,
  * clarification is outstanding, or expert/offer request is authorized. Never use model attestations. */
 authorizeContent(request: CommunicationRequest): Promise<boolean>;
 /** Must screen with CURRENT known secrets (including rotations), without returning secrets. */
 containsCurrentSecret(text: string): Promise<boolean>;
}
export interface ProviderReceipt { providerId: string; costMicroUsd: number | null }
export interface CommunicationProvider {
 /** Provider must persistently deduplicate this key. */
 send(message: { idempotencyKey: string; from: string; to: string; subject: string; body: string }): Promise<ProviderReceipt>;
 /** not_sent must be authoritative, not a transient search miss or an eventually consistent list. */
 lookup(idempotencyKey: string): Promise<{ status: 'sent'; receipt: ProviderReceipt } | { status: 'not_sent' } | { status: 'unknown' }>;
}
export interface CommunicationRecord {
 request: CommunicationRequest; policyVersion: string; sender: string; recipient: string;
 subject: string; body: string; idempotencyKey: string; createdAt: number; expiresAt: number;
 attempts: number; status: 'queued' | 'dispatching' | 'sent' | 'paused' | 'refused';
 reason: string; cost: { known: boolean; microUsd: number | null }; receipt: ProviderReceipt | null;
 history: { at: number; reason: string; policyVersion: string; costKnown: boolean }[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = (s: string) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(s);
function receiptValid(r: ProviderReceipt) { return typeof r.providerId === 'string' && r.providerId.length > 0 && r.providerId.length <= 500 && (r.costMicroUsd === null || (Number.isSafeInteger(r.costMicroUsd) && r.costMicroUsd >= 0)); }
/** The underlying call may complete after a timeout; its intent remains ambiguous and is reconciled, never replayed blindly. */
async function bounded<T>(call: () => Promise<T>, milliseconds: number): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try {
  return await Promise.race([Promise.resolve().then(call), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('communication_provider_deadline')), milliseconds); })]);
 } finally { if (timer !== undefined) clearTimeout(timer); }
}
function render(r: CommunicationRequest, origin: string) {
 switch (r.template) {
  case 'clarification': return { subject: 'Your evaluation needs clarification', body: 'Please return to your evaluation intake and provide the requested information. Your evaluation will wait for your answer.' };
  case 'quote': {
   if (!r.packageId || !(r.packageId in PRICE_TABLE) || r.packageId === ('monitoring_pilot' as string)) throw new Error('quote_package_required');
   const p = PRICE_TABLE[r.packageId];
   return { subject: 'Your fixed evaluation quote', body: `${p.name}: ${priceLabel(p)}. Payment is required before evaluation begins. Review the fixed scope and accept in your evaluation intake.` };
  }
  case 'report_ready':
   if (!r.reportId || !validId(r.reportId)) throw new Error('invalid_report_id');
   return { subject: 'Your evaluation report is ready', body: `Your evaluation report is available at ${origin}/reports/${r.reportId}. Read its evidence and limitations before relying on its findings.` };
  case 'monitoring_offer': return { subject: 'Optional monitoring pilot', body: `The optional ${PRICE_TABLE.monitoring_pilot.name} is ${priceLabel(PRICE_TABLE.monitoring_pilot)}. Review the scope and separately authorize a subscription in your account.` };
  case 'expert_request': return { subject: 'Authorized evidence request', body: 'An evaluation needs independently sourced evidence. Please open your authorized evidence request and respond only within the agreed scope and consent policy.' };
  default: throw new Error('unsupported_template');
 }
}

export class PostgresCommunicationOutbox {
 private readonly policy: CommunicationPolicy;
 constructor(private readonly db: AgentTransactionalSql, policy: CommunicationPolicy, private readonly guards: CommunicationGuards) {
  this.policy = Object.freeze({ ...policy, enabledTemplates: Object.freeze([...policy.enabledTemplates]), approvedExpertContactIds: Object.freeze([...policy.approvedExpertContactIds]) });
  if (!validId(policy.tenantId) || !policy.version || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(policy.sender) ||
   ![policy.dailyCap, policy.maxDispatchAttempts, policy.dispatchTimeoutMs, policy.deliveryDeadlineMs].every(n => Number.isSafeInteger(n) && n > 0) ||
   !/^https:\/\/[^/]+$/.test(policy.reportOrigin)) throw new Error('invalid_communication_policy');
 }
 async get(id: string): Promise<CommunicationRecord | null> {
  const row = (await this.db.query<{ record: CommunicationRecord }>('SELECT record FROM company_autonomy.messages WHERE id=$1 AND tenant_id=$2', [id, this.policy.tenantId])).rows[0];
  return row?.record ?? null;
 }
 private async authorize(r: CommunicationRequest): Promise<ContactAuthorization> {
  const p = this.policy;
  if (p.mode !== 'autonomous.v1' || r.tenantId !== p.tenantId || !p.enabledTemplates.includes(r.template) || await this.guards.currentPolicyVersion(p.tenantId) !== p.version) throw new Error('policy_authority_denied');
  if (!await this.guards.authorizeContent(r)) throw new Error('message_content_not_authorized');
  const c = await this.guards.resolveContact(r.tenantId, r.jobId, r.contactId);
  if (!c || c.tenantId !== r.tenantId || c.jobId !== r.jobId || !c.active || c.optedOut || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw new Error('contact_authority_denied');
  if (r.template === 'monitoring_offer' ? !c.marketingOptIn : r.template === 'expert_request' ? !c.expertConsent || !p.approvedExpertContactIds.includes(r.contactId) : !c.productNotifications) throw new Error('contact_consent_denied');
  return c;
 }
 async enqueue(request: CommunicationRequest, now: number): Promise<CommunicationRecord> {
  const r = JSON.parse(JSON.stringify(request)) as CommunicationRequest;
  if (!Number.isSafeInteger(now) || ![r.id, r.tenantId, r.jobId, r.contactId].every(validId) || Object.keys(r).some(k => !['id','tenantId','jobId','contactId','template','packageId','reportId'].includes(k))) throw new Error('invalid_message_request');
  const c = await this.authorize(r), p = this.policy, content = render(r, p.reportOrigin);
  if (await this.guards.containsCurrentSecret(JSON.stringify({ r, ...content, sender: p.sender, recipient: c.email }))) throw new Error('message_secret_denied');
  const identity = digest({ r, policyVersion: p.version, sender: p.sender, recipient: c.email, ...content });
  const row: CommunicationRecord = { request: r, policyVersion: p.version, sender: p.sender, recipient: c.email, ...content,
   idempotencyKey: `company-message-${digest({ tenant: p.tenantId, id: r.id })}`, createdAt: now, expiresAt: now + p.deliveryDeadlineMs,
   attempts: 0, status: 'queued', reason: 'policy_authorized', cost: { known: true, microUsd: 0 }, receipt: null,
   history: [{ at: now, reason: 'policy_authorized', policyVersion: p.version, costKnown: true }] };
  return this.db.transaction(async tx => {
   // One tenant/day mutex serializes cap reservation and identity insertion, including concurrent retries.
   const day = new Date(now).toISOString().slice(0,10);
   await tx.query('INSERT INTO company_autonomy.message_days(tenant_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING', [p.tenantId, day]);
   await tx.query('SELECT reserved FROM company_autonomy.message_days WHERE tenant_id=$1 AND day=$2 FOR UPDATE', [p.tenantId, day]);
   const existing = (await tx.query<{ identity: string; record: CommunicationRecord }>('SELECT identity,record FROM company_autonomy.messages WHERE id=$1', [r.id])).rows[0];
   if (existing) { if (existing.identity !== identity) throw new Error('message_identity_conflict'); return existing.record; }
   const cap = await tx.query('UPDATE company_autonomy.message_days SET reserved=reserved+1 WHERE tenant_id=$1 AND day=$2 AND reserved<$3 RETURNING reserved', [p.tenantId, day, p.dailyCap]);
   if (!cap.rows.length) throw new Error('message_daily_cap');
   await tx.query('INSERT INTO company_autonomy.messages(id,identity,tenant_id,day,record,state,deadline) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)', [r.id, identity, p.tenantId, day, JSON.stringify(row), row.status, now]);
   return row;
  });
 }
 async dispatch(id: string, provider: CommunicationProvider, now: number): Promise<CommunicationRecord | null> {
  if (!validId(id) || !Number.isSafeInteger(now) || now < 0) throw new Error('invalid_dispatch');
  const claimToken = randomUUID();
  // Claim durable intent before any external side effect. A crashed dispatcher is recovered by receipt lookup only.
  const claim = await this.db.transaction(async tx => {
   const saved = (await tx.query<{record: CommunicationRecord; deadline: number}>('SELECT record,deadline FROM company_autonomy.messages WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id, this.policy.tenantId])).rows[0];
   if (!saved) return null;
   const r = saved.record;
   if (r.status === 'sent' || r.status === 'paused' || r.status === 'refused' || (r.status === 'dispatching' && Number(saved.deadline) > now)) return { record: r, action: 'none' as const };
   const action = r.status === 'dispatching' ? 'lookup' as const : 'send' as const;
   r.status = 'dispatching';
   await tx.query('UPDATE company_autonomy.messages SET record=$2::jsonb,state=$3,deadline=$4,claim_token=$5 WHERE id=$1', [id, JSON.stringify(r), r.status, now + this.policy.dispatchTimeoutMs, claimToken]);
   return { record: r, action };
  });
  if (!claim || claim.action === 'none') return claim?.record ?? null;
  const r = claim.record;
  const save = async (status: CommunicationRecord['status'], reason: string) => {
   r.status = status; r.reason = reason;
   r.history.push({ at: now, reason, policyVersion: this.policy.version, costKnown: r.cost.known });
   const updated = await this.db.query('UPDATE company_autonomy.messages SET record=$2::jsonb,state=$3,deadline=$4 WHERE id=$1 AND claim_token=$5 RETURNING id', [id, JSON.stringify(r), status, now + this.policy.dispatchTimeoutMs, claimToken]);
   if (!updated.rows.length) throw new Error('message_dispatch_lease_lost');
   return r;
  };
  if (claim.action === 'lookup') {
   let result: Awaited<ReturnType<CommunicationProvider['lookup']>>;
   try { result = await bounded(() => provider.lookup(r.idempotencyKey), this.policy.dispatchTimeoutMs); } catch { r.cost = { known: false, microUsd: null }; return save('paused', 'receipt_lookup_failed'); }
   if (result.status === 'sent' && receiptValid(result.receipt)) { r.receipt = result.receipt; r.cost = { known: result.receipt.costMicroUsd !== null, microUsd: result.receipt.costMicroUsd }; return save('sent', 'authoritative_receipt_recovered'); }
   if (result.status !== 'not_sent') { r.cost = { known: false, microUsd: null }; return save('paused', 'ambiguous_dispatch_no_blind_retry'); }
   r.cost = { known: true, microUsd: 0 };
  }
  if (now >= r.expiresAt || new Date(now).toISOString().slice(0,10) !== new Date(r.createdAt).toISOString().slice(0,10) || r.attempts >= this.policy.maxDispatchAttempts) return save('refused', 'delivery_deadline_or_attempt_limit');
  try {
   const current = await this.authorize(r.request);
   if (current.email !== r.recipient || r.policyVersion !== this.policy.version || await this.guards.containsCurrentSecret(JSON.stringify(r))) return save('refused', 'current_authorization_or_secret_denied');
  } catch { return save('refused', 'current_authorization_or_secret_denied'); }
  r.attempts += 1; r.cost = { known: false, microUsd: null };
  // Persist attempts/unknown cost before calling provider; unknown usage is never reported as zero.
  await save('dispatching', 'provider_dispatch_intent');
  try {
   const receipt = await bounded(() => provider.send({ idempotencyKey: r.idempotencyKey, from: r.sender, to: r.recipient, subject: r.subject, body: r.body }), this.policy.dispatchTimeoutMs);
   if (!receiptValid(receipt)) return save('paused', 'invalid_provider_receipt');
   r.receipt = receipt; r.cost = { known: receipt.costMicroUsd !== null, microUsd: receipt.costMicroUsd };
   return await save('sent', 'provider_receipt');
  } catch { return save('dispatching', 'dispatch_ambiguous_await_receipt'); }
 }
 async recoverDue(provider: CommunicationProvider, now: number): Promise<(CommunicationRecord | null)[]> {
  const rows = (await this.db.query<{id: string}>('SELECT id FROM company_autonomy.messages WHERE tenant_id=$1 AND state IN ($2,$3) AND deadline<=$4 ORDER BY id LIMIT 100', [this.policy.tenantId, 'queued', 'dispatching', now])).rows;
  const results: (CommunicationRecord | null)[] = [];
  for (const row of rows) results.push(await this.dispatch(row.id, provider, now));
  return results;
 }
}
