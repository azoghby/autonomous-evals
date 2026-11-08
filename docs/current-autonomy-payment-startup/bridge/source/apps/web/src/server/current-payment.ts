import 'server-only';
import type Stripe from 'stripe';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { CompanyRequest } from '@ae/core/agents/autonomy/company';
import { autonomyDigest } from '@ae/core/agents/autonomy/policy';
import { buildQuote, sanitizeIntake, type FixedQuote } from '@ae/core/agents/commercial';
import type { ReleasePaymentReceipt, ReleasePrincipal } from '@/server/autonomy-release';

type Canonical = {
  id: string; customer_id: string; package: FixedQuote['package']; environment: 'test'|'live';
  state: string; is_mock: boolean; workflow_run_id: string|null; retest_of_job_id: string|null;
  intake: Record<string, unknown>; version: number; price_cents: number; pricing_mode: string;
  stripe_checkout_session_id: string|null; scope_summary:string; deliverables:unknown;
};
type Payment = {id:string;job_id:string;quote_version:number;environment:'test'|'live';amount_cents:number;
  currency:string;status:string;kind:string;stripe_checkout_session_id:string;stripe_payment_intent_id:string|null};
export interface BridgeOptions {
  sql: AgentTransactionalSql;
  now(): number;
  /** Current server policy/target authorization; called afresh even on duplicate/replay. No model authority. */
  authorize(principal: ReleasePrincipal, request: CompanyRequest): Promise<boolean>;
  /** Owner wraps stripe().webhooks.constructEvent(raw, signature, webhookSecret()). Never JSON.parse. */
  verifyStripe(raw: string, signature: string): Stripe.Event;
}
const fail = (reason: string): never => {throw new Error(`current_payment_${reason}`);};
const terminal = new Set(['cancelled','failed','delivered','payment_review']);
const record = (v:unknown): Record<string,unknown> => v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const text = (v:unknown): string|null => typeof v==='string' ? v : null;

/** Additive bridge over CURRENT canonical rows. Existing Stripe/USDC charging semantics are untouched. */
export function createCurrentPaymentBridge(options: BridgeOptions) {
  const {sql}=options;
  async function canonical(jobId:string):Promise<Canonical> {
    const row=(await sql.query<Canonical>(`SELECT j.id,j.customer_id,j.package,j.environment,j.state,j.is_mock,
      j.workflow_run_id,j.retest_of_job_id,j.intake,q.version,q.price_cents,q.pricing_mode,q.stripe_checkout_session_id,q.scope_summary,q.deliverables
      FROM public.jobs j JOIN public.quotes q ON q.job_id=j.id
      WHERE j.id::text=$1 ORDER BY q.version DESC LIMIT 1`,[jobId])).rows[0];
    if(!row || row.is_mock || !row.workflow_run_id || terminal.has(row.state)) return fail('canonical_job_unavailable');
    if(row.pricing_mode!=='fixed')return fail('per_finding_contract_unsupported');
    return row;
  }
  async function loadRequest(principal:ReleasePrincipal,jobId:string):Promise<CompanyRequest|null> {
    const c=await canonical(jobId);
    if(principal.subject!==c.customer_id || principal.tenantId!==c.customer_id)return null;
    const i=record(c.intake), endpoint=record(i.endpoint);
    if(i.authorizedToTest!==true || i.package!==c.package)return fail('target_authorization_required');
    let host:string|null=null;
    if(typeof endpoint.url==='string') {try{host=new URL(endpoint.url).hostname;}catch{return fail('invalid_endpoint');}}
    const messages=(await sql.query<{body:string}>(`SELECT body FROM (SELECT body,created_at,id FROM public.messages
      WHERE job_id::text=$1 AND role='customer' ORDER BY created_at DESC,id DESC LIMIT 5) m ORDER BY created_at,id`,[jobId])).rows;
    // Only bounded declared commercial fields reach qualification; credentials are in job_credentials.
    // sanitizeIntake applies the existing credential-pattern redactor before persistence/model input.
    const summary=sanitizeIntake({requestedPackage:c.package,notes:text(i.notes),
      systemPromptExcerpt:text(endpoint.systemPrompt)??text(i.systemPrompt),
      trace:typeof i.trace==='string'?{bytes:Buffer.byteLength(i.trace),preview:i.trace.slice(0,1500)}:null,
      endpointHost:host,clarifications:messages.map(m=>m.body)});
    const request:CompanyRequest={tenantId:c.customer_id,job:{jobId:c.id,customerId:c.customer_id,package:c.package,
      environment:c.environment,quoteVersion:c.version,linkedRetestOf:c.retest_of_job_id,isFixture:false},
      intake:summary,round:0};
    if(!await options.authorize(principal,request))return null;
    return request;
  }
  async function current(request:CompanyRequest) {
    const principal={tenantId:request.tenantId,subject:request.job.customerId};
    const fresh=await loadRequest(principal,request.job.jobId);
    if(!fresh || autonomyDigest(fresh)!==autonomyDigest(request))return fail('authorization_or_request_changed');
    return canonical(request.job.jobId);
  }
  async function bind(request:CompanyRequest,quote:FixedQuote) {
    const c=await current(request);
    // Scope is authored by qualification; all commercial quantities remain code owned. Bind its exact digest.
    const expected=buildQuote(request.job,c.package,c.version,c.scope_summary);
    if(autonomyDigest(expected)!==autonomyDigest(quote) || quote.priceCents!==c.price_cents
      || quote.priceMicroUsd!==c.price_cents*10_000 || autonomyDigest(quote.deliverables)!==autonomyDigest(c.deliverables))return fail('quote_contract_mismatch');
    const result=await sql.query<{result:string}>('SELECT current_autonomy_payment.prepare_binding($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [request.tenantId,c.id,c.version,autonomyDigest(quote),autonomyDigest(request),c.environment,c.price_cents,c.stripe_checkout_session_id]);
    if(!['prepared','duplicate','accepted'].includes(result.rows[0]?.result))return fail('binding_conflict');
    await current(request);
    return c;
  }
  async function prepareQuote(request:CompanyRequest,quote:FixedQuote) {
    const c=await bind(request,quote);
    if(!['quoted','awaiting_payment'].includes(c.state))return fail('checkout_state_refused');
    // This is the ACTUAL current owner checkout route. It requires owner auth and explicit acceptance,
    // reuses open Stripe sessions, and emits quote_accepted to the existing Workflow. No fabricated approval.
    return {path:`/api/jobs/${encodeURIComponent(c.id)}/accept-quote`,method:'POST' as const,
      body:{quoteVersion:c.version},requiresOwnerAcceptance:true as const,quoteDigest:autonomyDigest(quote)};
  }
  async function verifyPayment(request:CompanyRequest,quote:FixedQuote,receipt:ReleasePaymentReceipt):Promise<boolean> {
    await bind(request,quote);
    if(!receipt.settled || receipt.currency!=='USD' || Number(receipt.amount_micro_usd)!==quote.priceMicroUsd
      || receipt.record.quoteDigest!==autonomyDigest(quote))return false;
    const retained=(await sql.query<ReleasePaymentReceipt>(`SELECT receipt_id,settled,amount_micro_usd,currency,record
      FROM company_autonomy_release.payment_receipts WHERE tenant_id=$1 AND job_id=$2 AND receipt_id=$3`,
      [request.tenantId,request.job.jobId,receipt.receipt_id])).rows[0];
    if(!retained || !retained.settled || retained.currency!==receipt.currency
      || Number(retained.amount_micro_usd)!==Number(receipt.amount_micro_usd)
      || autonomyDigest(retained.record)!==autonomyDigest(receipt.record))return false;
    const answer=(await sql.query<{valid:boolean}>('SELECT current_autonomy_payment.receipt_valid($1,$2,$3,$4) AS valid',
      [request.tenantId,request.job.jobId,autonomyDigest(quote),receipt.receipt_id])).rows[0]?.valid===true;
    await current(request);return answer;
  }
  async function ingestStripe(raw:string,signature:string,ignoreUnbound=false) {
    if(!signature)return fail('signature_required');
    const event=options.verifyStripe(raw,signature); // authenticity gate precedes ANY SQL read/write
    const handled=['checkout.session.completed','checkout.session.async_payment_succeeded','charge.refunded','payment_intent.canceled'];
    if(!handled.includes(event.type))return {status:'ignored'};
    const obj=record(event.data.object), env=event.livemode?'live':'test';
    if(obj.livemode!==event.livemode)return fail('event_environment_mismatch');
    let sessionId:string|null=null, piId:string|null=null, status='paid';
    if(event.type.startsWith('checkout.session.')) {
      const meta=record(obj.metadata);
      if(obj.mode!=='payment' || obj.payment_status!=='paid')return ignoreUnbound?{status:'ignored_unbound'}:fail('settled_fixed_payment_required');
      if(meta.pricing_mode!=='fixed')return ignoreUnbound?{status:'ignored_unbound'}:fail('per_finding_contract_unsupported');
      if(obj.livemode!==event.livemode || meta.environment!==env)return fail('event_environment_mismatch');
      sessionId=text(obj.id);
    } else {
      status=event.type==='charge.refunded'?'refunded':'cancelled';
      if(status==='refunded' && !(typeof obj.amount_refunded==='number' && obj.amount_refunded>0))return fail('refund_evidence_required');
      piId=event.type==='payment_intent.canceled'?text(obj.id):text(obj.payment_intent)??text(record(obj.payment_intent).id);
      if(!piId)return fail('payment_intent_required');
    }
    const payment=(await sql.query<Payment>(`SELECT id,job_id,quote_version,environment,amount_cents,currency,status,kind,
      stripe_checkout_session_id,stripe_payment_intent_id FROM public.payments
      WHERE ($1::text IS NOT NULL AND stripe_checkout_session_id=$1) OR ($2::text IS NOT NULL AND stripe_payment_intent_id=$2)`,[sessionId,piId])).rows;
    if(payment.length!==1)return ignoreUnbound && payment.length===0?{status:'ignored_unbound'}:fail('canonical_receipt_required');
    const p=payment[0];
    if(p.environment!==env || p.kind!=='one_time' || p.currency!=='usd')return fail('payment_binding_mismatch');
    if(status==='paid') {
      const meta=record(obj.metadata);
      if(meta.job_id!==p.job_id || meta.quote_version!==String(p.quote_version) || obj.client_reference_id!==p.job_id
        || obj.amount_total!==p.amount_cents || obj.currency!=='usd' || p.status!=='paid'
        || (text(obj.payment_intent)??text(record(obj.payment_intent).id))!==p.stripe_payment_intent_id)return fail('event_payment_mismatch');
    }
    const binding=(await sql.query<{tenant_id:string;quote_digest:string}>(`SELECT tenant_id,quote_digest FROM current_autonomy_payment.bindings
      WHERE job_id=$1 AND quote_version=$2`,[p.job_id,p.quote_version])).rows[0];
    if(!binding)return ignoreUnbound?{status:'ignored_unbound'}:fail('prepared_quote_binding_required');
    // Revocations must persist even when owner/target authority was revoked; positives recheck it.
    if(status==='paid') {
      const request=await loadRequest({tenantId:binding.tenant_id,subject:binding.tenant_id},p.job_id);
      if(!request)return fail('authorization_revoked');
    }
    const result=(await sql.query<{result:string}>('SELECT current_autonomy_payment.ingest_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS result',
      [binding.tenant_id,p.job_id,p.quote_version,'stripe',env,event.id,autonomyDigest(event),p.stripe_checkout_session_id,
        p.amount_cents,'USD',status,binding.quote_digest,p.id])).rows[0]?.result;
    if(!result || ['conflict','invalid','revoked'].includes(result))return fail(`receipt_${result??'missing'}`);
    return {status:result};
  }
  async function drainReceipts(tenantId:string,jobId:string) {
    const request=await loadRequest({tenantId,subject:tenantId},jobId);
    if(!request)return fail('authorization_revoked');
    const events=await sql.query<{event_id:string}>(`SELECT ev.event_id FROM current_autonomy_payment.events ev JOIN current_autonomy_payment.outbox o USING(provider,environment,event_id)
      WHERE ev.tenant_id=$1 AND ev.job_id=$2 AND NOT o.delivered ORDER BY ev.event_id LIMIT 100`,[tenantId,jobId]);
    for(const event of events.rows) {
      await current(request);
      await sql.query('SELECT current_autonomy_payment.publish_receipt($1,$2,$3)',[tenantId,jobId,event.event_id]);
    }
    await current(request);
    return {checked:events.rows.length};
  }
  async function drainPendingReceipts(limit=25) {
    if(!Number.isSafeInteger(limit) || limit<1 || limit>100)return fail('drain_limit_refused');
    const jobs=await sql.query<{tenant_id:string;job_id:string}>(`SELECT DISTINCT ev.tenant_id,ev.job_id
      FROM current_autonomy_payment.events ev JOIN current_autonomy_payment.outbox o USING(provider,environment,event_id)
      WHERE NOT o.delivered ORDER BY ev.tenant_id,ev.job_id LIMIT $1`,[limit]);
    const outcomes=[];
    for(const job of jobs.rows) {
      try{outcomes.push({jobId:job.job_id,...await drainReceipts(job.tenant_id,job.job_id)});}
      catch{outcomes.push({jobId:job.job_id,blocked:true});}
    }
    return {outcomes};
  }
  return {loadRequest,prepareQuote,verifyPayment,ingestStripe,drainReceipts,drainPendingReceipts,
    ingestStripeIfBound:(raw:string,signature:string)=>ingestStripe(raw,signature,true),
    async ingestX402():Promise<never> {return fail('usdc_release_currency_contract_unsupported');}};
}
export type CurrentPaymentBridge=ReturnType<typeof createCurrentPaymentBridge>;
