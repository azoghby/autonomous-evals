/** Composed current owner startup over actual SQL (PGlite). Real modules: current-payment-startup,
 * current-payment bridge, current-stripe-payment, current-autonomy, autonomy-release, autonomous-paid
 * and the payment/release/paid migrations. Scripted only: Stripe signature SDK (provider boundary),
 * session viewer, target transport, and the company state machine driver (caller supplies it). */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {vi} from 'vitest';
import {createCurrentPaymentStartup,type CurrentOwnerAdapters} from '@/server/current-payment-startup';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import type {AutonomousPolicy} from '@ae/core/agents/autonomy/policy';
import type {CompanyRequest} from '@ae/core/agents/autonomy/company';
import {buildQuote} from '@ae/core/agents/commercial';
import {memoryDataLedger} from '../../autonomous-company/data-fixtures';

const stage=()=>process.env.WORKFLOW_STAGE!;
export const read=(p:string)=>readFileSync(join(stage(),p),'utf8');
export const engines:PGlite[]=[];
export async function closeEngines(){await Promise.all(engines.splice(0).map(e=>e.close()));}

export async function database(){
 const engine=new PGlite();engines.push(engine);
 for(const p of ['docs/current-autonomy-integration/dependencies/owner-migrations/app.baseline.0000_init.sql',
  'docs/current-autonomy-integration/dependencies/owner-migrations/app.baseline.0006_per_finding_pricing.sql',
  'apps/web/src/server/autonomy-release.sql','apps/web/src/server/autonomous-paid-authority.sql',
  'docs/current-autonomy-payment-startup/sql/001-current-payment.sql','apps/web/src/server/autonomous-paid.sql',
  'packages/core/src/agents/persistence-migrations/001-agent-persistence.sql'])await engine.exec(read(p));
 const sql:AgentTransactionalSql={query:(q,p)=>engine.query(q,p) as never,transaction:fn=>engine.transaction(tx=>fn({query:(q,p)=>tx.query(q,p) as never}))};
 return {engine,sql};
}

export const SCOPE='Text evaluation';
const jobRef=(job:string,tenant:string)=>({jobId:job,customerId:tenant,package:'text_eval' as const,environment:'test' as const,quoteVersion:1,linkedRetestOf:null,isFixture:false});
export const deliverables=buildQuote(jobRef('j','t'),'text_eval',1,SCOPE).deliverables;

/** Seeds a canonical customer/job/latest fixed quote as the current app would. */
export async function seedJob(engine:PGlite,ids:{tenant:string;job:string;session?:string;state?:string}){
 const session=ids.session??`cs_${ids.job.slice(-4)}`;
 await engine.query('INSERT INTO customers(id,email) VALUES($1,$2) ON CONFLICT DO NOTHING',[ids.tenant,`${ids.tenant}@example.invalid`]);
 await engine.query(`INSERT INTO jobs(id,customer_id,package,state,intake,workflow_run_id) VALUES($1,$2,'text_eval',$3,$4::jsonb,'run_durable')`,
  [ids.job,ids.tenant,ids.state??'awaiting_payment',JSON.stringify({package:'text_eval',authorizedToTest:true,notes:'Check response quality',endpoint:{url:'https://target.invalid/v1',systemPrompt:'Be helpful'}})]);
 await engine.query(`INSERT INTO quotes(job_id,version,package,price_cents,scope_summary,deliverables,accepted_at,stripe_checkout_session_id) VALUES($1,1,'text_eval',500,$2,$3::jsonb,now(),$4)`,
  [ids.job,SCOPE,JSON.stringify(deliverables),session]);
 return session;
}
/** The row recordPaymentFromSession persists before autonomy ingestion. */
export async function recordPayment(engine:PGlite,ids:{payment:string;job:string;session:string;pi:string;event:string}){
 await engine.query(`INSERT INTO payments(id,job_id,quote_version,stripe_event_id,stripe_checkout_session_id,stripe_payment_intent_id,amount_cents,currency,environment,kind,status)
  VALUES($1,$2,1,$3,$4,$5,500,'usd','test','one_time','paid')`,[ids.payment,ids.job,ids.event,ids.session,ids.pi]);
}
export const paidEvent=(o:{id:string;job:string;session:string;pi:string;amount?:number})=>({id:o.id,type:'checkout.session.completed',livemode:false,pending_webhooks:1,
 data:{object:{id:o.session,object:'checkout.session',mode:'payment',payment_status:'paid',livemode:false,client_reference_id:o.job,amount_total:o.amount??500,currency:'usd',payment_intent:o.pi,
  metadata:{job_id:o.job,quote_version:'1',environment:'test',pricing_mode:'fixed'}}}});
export const refundEvent=(o:{id:string;pi:string;type?:string})=>({id:o.id,type:o.type??'charge.refunded',livemode:false,pending_webhooks:1,
 data:{object:{id:`ch_${o.id}`,object:'charge',livemode:false,amount_refunded:100,payment_intent:o.pi}}});

export const policyFor=(tenant:string):AutonomousPolicy=>({schema:'autonomous-company-policy/v1',version:'v1',enabled:true,tenantId:tenant,periodId:'period',
 rootBudgetMicroUsd:250000000,singleJobCapMicroUsd:3000000,comparisonJobCapMicroUsd:5000000,
 roleCapsMicroUsd:{commercial:35000000,evaluation_engineer:65000000,quality_investigator:65000000,company_operator:35000000},
 agents:{commercial:{id:'commercial',version:1},evaluation_engineer:{id:'engineer',version:1},quality_investigator:{id:'investigator',version:1},company_operator:{id:'operator',version:1}},
 allowedActions:['agent_task'],leaseMs:100,actionDeadlineMs:60000,maxRecoveryChecks:3});

export type Stripe={construct:ReturnType<typeof vi.fn>};
/** Construct the real composed startup with explicit owner adapters. */
export async function composed(stripe:Stripe,opts:{tenant?:string;job?:string}={}){
 const {engine,sql}=await database();
 const tenant=opts.tenant??'00000000-0000-4000-8000-0000000000a1', job=opts.job??'00000000-0000-4000-8000-0000000000b1';
 const session=await seedJob(engine,{tenant,job});
 const state={viewer:tenant as string|null,authorized:true,clock:1000,viewerCalls:0,revokeViewerAtCall:0};
 const operations=memoryDataLedger();
 const evaluateWithServices=vi.fn(async(..._args:unknown[]):Promise<never>=>{throw Error('evaluate_not_scripted');});
 const enqueue=vi.fn(async()=>{}), enqueueQuote=vi.fn(async()=>{});
 const owner:CurrentOwnerAdapters={
  config:{db:sql,policyFor:async t=>policyFor(t),currentSecrets:async()=>[],
   naive:{createSession:vi.fn(async()=>{throw Error('no_provider');}),getSession:vi.fn(async()=>{throw Error('no_provider');}),listAgentSessions:vi.fn(async()=>({data:[],nextCursor:null}))},
   workerId:'worker',idempotencyNamespace:'offline-review',operationsFor:async()=>operations,
   sourcePermissions:async()=>[{sourceId:'source_a',permissionDigest:'a'.repeat(64)}],
   verifyProviderReceipt:async()=>false,data:vi.fn(async()=>({status:'ready' as const,digest:'b'.repeat(64),reasons:[]})),
   paidPolicy:async()=>({jobCapMicroUsd:3000000,targetReservationMicroUsd:20,judgeReservationMicroUsd:20}),
   recoverEvaluation:async()=>null,now:()=>state.clock,
   contextFor:async(r:CompanyRequest)=>({jobId:r.job.jobId,environment:r.job.environment,budgetMicroUsd:3000000,recordCost:async()=>{},recordProgress:async()=>{}}) as never,
   evaluateWithServices:evaluateWithServices as never},
  bridge:{sql,now:()=>state.clock,authorize:async()=>state.authorized},
  dependencies:{
   viewer:async()=>{state.viewerCalls++;if(state.revokeViewerAtCall&&state.viewerCalls>=state.revokeViewerAtCall)return null;return state.viewer?{id:state.viewer,email:'owner@example.invalid',isOperator:false}:null;},
   cron:()=>null,
   job:async id=>(await engine.query<{id:string;customerId:string;workflowRunId:string|null;environment:string;isMock:boolean}>(
    `SELECT id::text AS id,customer_id::text AS "customerId",workflow_run_id AS "workflowRunId",environment::text AS environment,is_mock AS "isMock" FROM jobs WHERE id::text=$1`,[id])).rows[0]??null,
   rich:(async(_ctx:unknown,authority:{autonomous?:unknown})=>({paid:authority.autonomous})) as never},
  enqueue,enqueueQuote,exclusiveDispatch:async()=>true,
 };
 const startup=createCurrentPaymentStartup(owner);
 const request=()=>startup.bridge.loadRequest({tenantId:tenant,subject:tenant},job).then(r=>r!);
 const quote=async()=>buildQuote((await request()).job,'text_eval',1,SCOPE);
 const http=()=>new Request('https://local.invalid/api/jobs/x/autonomy',{method:'POST'});
 const ingest=(event:unknown)=>{stripe.construct.mockReturnValueOnce(event);return startup.bridge.ingestStripeIfBound('RAW','signed');};
 const permit=()=>engine.query("INSERT INTO company_autonomy_release.source_permissions(tenant_id,job_id,source_id,permission_digest,allowed,expires_at) VALUES($1,$2,'source_a',$3,true,1000000000000)",[tenant,job,'a'.repeat(64)]);
 const due=()=>engine.query('UPDATE company_autonomy_release.job_bindings SET next_tick_at=0');
 const valid=async(eventId:string)=>(await engine.query<{v:boolean}>('SELECT current_autonomy_payment.receipt_valid($1,$2,(SELECT quote_digest FROM current_autonomy_payment.bindings WHERE job_id=$2),$3) AS v',[tenant,job,`stripe:test:${eventId}`])).rows[0].v;
 /** Bootstrap through the actual HTTP application, prepare the actual checkout binding, record and ingest payment. */
 async function paidAndBound(){
  const boot=await startup.bootstrap(http(),job);if(boot.status!==200)throw Error('bootstrap '+boot.status+' '+await boot.text());
  await startup.bridge.prepareQuote(await request(),await quote());
  await recordPayment(engine,{payment:'00000000-0000-4000-8000-0000000000c1',job,session,pi:'pi_1',event:'evt_paid'});
  const r=await ingest(paidEvent({id:'evt_paid',job,session,pi:'pi_1'}));if(r.status!=='queued')throw Error('ingest '+JSON.stringify(r));
  await permit();
 }
 return {engine,sql,tenant,job,session,state,operations,owner,startup,evaluateWithServices,enqueue,enqueueQuote,request,quote,http,ingest,permit,due,valid,paidAndBound};
}
