/** Shared real-SQL payment fixture (not a test). Actual baseline DDL + release access DDL + the reviewed
 * additive payment migration in PGlite; the actual composed bridge (apps/web/src/server/current-payment.ts).
 * Stripe signature verification is the only scripted boundary: verified events enter through the same SQL
 * function the bridge calls after verification (current_autonomy_payment.ingest_event). */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {createCurrentPaymentBridge} from '@/server/current-payment';

const qd='a'.repeat(64),rd='b'.repeat(64);
const hex=(n:number,w=12)=>n.toString(16).padStart(w,'0');
export async function paymentFixture(){
 const stage=process.env.WORKFLOW_STAGE!;const read=(p:string)=>readFileSync(join(stage,p),'utf8');
 const db=new PGlite();
 for(const p of ['app.baseline.0000_init.sql','app.baseline.0006_per_finding_pricing.sql','autonomy-release.access.sql'])await db.exec(read('docs/current-autonomy-integration/dependencies/owner-migrations/'+p));
 await db.exec(read('docs/current-autonomy-payment-startup/sql/001-current-payment.sql'));
 const sql:AgentTransactionalSql={query:(s,p)=>db.query(s,p) as never,transaction:fn=>db.transaction(tx=>fn({query:(s,p)=>tx.query(s,p) as never}))};
 const bridge=createCurrentPaymentBridge({sql,now:()=>0,authorize:async()=>true,verifyStripe:()=>{throw Error('not used: verified events are injected at the SQL boundary');}});
 const ingest=(t:string,j:string,eid:string,status:'paid'|'refunded',session:string,payment:string)=>db.query<{result:string}>('SELECT current_autonomy_payment.ingest_event($1,$2,1,$3,$4,$5,$6,$7,500,$8,$9,$10,$11) AS result',[t,j,'stripe','test',eid,(status==='paid'?'c':'d').repeat(64),session,'USD',status,qd,payment]).then(r=>r.rows[0].result);
 const publish=(t:string,j:string,eid:string)=>db.query<{result:string}>('SELECT current_autonomy_payment.publish_receipt($1,$2,$3) AS result',[t,j,eid]).then(r=>r.rows[0].result);
 const valid=(t:string,j:string,eid:string)=>db.query<{valid:boolean}>('SELECT current_autonomy_payment.receipt_valid($1,$2,$3,$4) AS valid',[t,j,qd,'stripe:test:'+eid]).then(r=>r.rows[0].valid);
 /** A bootstrapped (release-bound), prepared fixed-quote job with a canonical paid payment row. */
 async function job(n:number,tenantPrefix:string){
  const tenant=`${tenantPrefix}-0000-4000-8000-${hex(n)}`,id=`11111111-0000-4000-8000-${hex(n)}`,payment=`22222222-0000-4000-8000-${hex(n)}`,session=`cs_${n}`;
  await db.query('INSERT INTO customers(id,email) VALUES($1,$2)',[tenant,`t${n}@fixture.invalid`]);
  await db.query(`INSERT INTO jobs(id,customer_id,package,state,intake,workflow_run_id) VALUES($1,$2,'text_eval','running',$3,'run')`,[id,tenant,JSON.stringify({package:'text_eval',authorizedToTest:true,notes:'fixture',endpoint:{url:'https://target.example/v1'}})]);
  await db.query(`INSERT INTO quotes(job_id,version,package,price_cents,scope_summary,deliverables,accepted_at,stripe_checkout_session_id) VALUES($1,1,'text_eval',500,'scope','[]',now(),$2)`,[id,session]);
  await db.query(`INSERT INTO payments(id,job_id,quote_version,stripe_event_id,stripe_checkout_session_id,amount_cents,environment) VALUES($1,$2,1,$3,$4,500,'test')`,[payment,id,'evt_pay_'+n,session]);
  await db.query(`INSERT INTO company_autonomy_release.job_bindings VALUES($1,$2,$1,'v1',$3,true,0)`,[tenant,id,JSON.stringify({tenantId:tenant,job:{customerId:tenant,jobId:id,environment:'test'}})]);
  await db.query('SELECT current_autonomy_payment.prepare_binding($1,$2,1,$3,$4,$5,500,$6)',[tenant,id,qd,rd,'test',session]);
  return {tenant,id,payment,session};
 }
 /** Paid, drained, then refunded: the refund event's outbox row can never be published. */
 async function refundedJob(n:number){
  const j=await job(n,'00000000');
  if(await ingest(j.tenant,j.id,'evt_pay_'+n,'paid',j.session,j.payment)!=='queued')throw Error('fixture paid ingest');
  if(await publish(j.tenant,j.id,'evt_pay_'+n)!=='published')throw Error('fixture publish');
  if(await ingest(j.tenant,j.id,'evt_refund_'+n,'refunded',j.session,j.payment)!=='queued')throw Error('fixture refund ingest');
  return j;
 }
 /** Release-visible retained receipt (what verifyPayment reads), not merely current validity. */
 const published=(t:string,j:string,eid:string)=>db.query<{n:number}>('SELECT count(*)::int AS n FROM company_autonomy_release.payment_receipts WHERE tenant_id=$1 AND job_id=$2 AND receipt_id=$3',[t,j,'stripe:test:'+eid]).then(r=>r.rows[0].n===1);
 const undelivered=()=>db.query<{n:number}>('SELECT count(*)::int AS n FROM current_autonomy_payment.outbox WHERE NOT delivered').then(r=>r.rows[0].n);
 return {db,sql,bridge,job,refundedJob,ingest,publish,valid,published,undelivered};
}
