import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const candidates=[process.env.AUTONOMY_NODE_MODULES,'node_modules','tests/track-b/node_modules','/tmp/sandbox-generation-deps.cBCEai/node_modules','/tmp/track-b-harness/node_modules'].filter(Boolean);
const deps=candidates.find(p=>existsSync(resolve(p,'@electric-sql/pglite/dist/index.js')));
if(!deps) throw new Error('offline_pglite_dependencies_required');
const {PGlite}=await import(pathToFileURL(resolve(deps,'@electric-sql/pglite/dist/index.js')).href);
const root=new URL('../../../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const migration=read('docs/current-autonomy-payment-startup/sql/001-current-payment.sql');
const tenant='00000000-0000-4000-8000-000000000001', job='00000000-0000-4000-8000-000000000002', payment='00000000-0000-4000-8000-000000000003';
const qd='a'.repeat(64),rd='b'.repeat(64),ed='c'.repeat(64);
async function setup(t,release=true){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(read('docs/current-autonomy-integration/dependencies/owner-migrations/app.baseline.0000_init.sql'));
 await db.exec(read('docs/current-autonomy-integration/dependencies/owner-migrations/app.baseline.0006_per_finding_pricing.sql'));
 await db.exec(read('docs/current-autonomy-integration/dependencies/owner-migrations/autonomy-release.access.sql'));
 await db.exec(migration);
 await db.query('INSERT INTO customers(id,email) VALUES($1,$2)',[tenant,'fixture@example.invalid']);
 await db.query(`INSERT INTO jobs(id,customer_id,package,state,intake,workflow_run_id) VALUES($1,$2,'text_eval','awaiting_payment','{}','run')`,[job,tenant]);
 await db.query(`INSERT INTO quotes(job_id,version,package,price_cents,scope_summary,deliverables,accepted_at,stripe_checkout_session_id) VALUES($1,1,'text_eval',500,'scope','[]',now(),'cs_1')`,[job]);
 await db.query(`INSERT INTO payments(id,job_id,quote_version,stripe_event_id,stripe_checkout_session_id,amount_cents,environment) VALUES($1,$2,1,'evt_1','cs_1',500,'test')`,[payment,job]);
 const bindRelease=()=>db.query(`INSERT INTO company_autonomy_release.job_bindings VALUES($1,$2,$1,'v1',$3,true,0)`,[tenant,job,JSON.stringify({tenantId:tenant,job:{customerId:tenant,jobId:job,environment:'test'}})]);
 if(release) await bindRelease();
 const prepare=(overrides=[])=>db.query('SELECT current_autonomy_payment.prepare_binding($1,$2,$3,$4,$5,$6,$7,$8) AS result',[tenant,job,1,qd,rd,'test',500,'cs_1'].map((v,i)=>overrides[i]===undefined?v:overrides[i]));
 const ingest=(override={})=>{const x={tenant,job,v:1,provider:'stripe',env:'test',id:'evt_1',digest:ed,session:'cs_1',amount:500,currency:'USD',status:'paid',qd,payment,...override};return db.query('SELECT current_autonomy_payment.ingest_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS result',Object.values(x));};
 const publish=(eid='evt_1')=>db.query('SELECT current_autonomy_payment.publish_receipt($1,$2,$3) AS result',[tenant,job,eid]);
 const valid=()=>db.query('SELECT current_autonomy_payment.receipt_valid($1,$2,$3,$4) AS valid',[tenant,job,qd,'stripe:test:evt_1']).then(r=>r.rows[0].valid);
 await prepare();return {db,prepare,ingest,publish,valid,bindRelease};
}
test('actual baseline migrations + additive migration survive reapply; PUBLIC cannot read or execute',async t=>{
 const {db}=await setup(t);await db.exec(migration);
 await db.exec('CREATE ROLE payment_customer; SET ROLE payment_customer');
 await assert.rejects(db.query('SELECT * FROM current_autonomy_payment.bindings'),/permission denied/i);
 await assert.rejects(db.query(`SELECT current_autonomy_payment.receipt_valid('t','j','q','r')`),/permission denied/i);
 await db.exec('RESET ROLE');
});
test('verified event/outbox survives pre-bootstrap delivery and retry publishes exactly one retained receipt',async t=>{
 const {db,ingest,publish,valid,bindRelease}=await setup(t,false);
 assert.equal((await ingest()).rows[0].result,'queued');
 assert.equal((await publish()).rows[0].result,'waiting_or_revoked');
 assert.equal(await valid(),false);await bindRelease();
 assert.equal((await publish()).rows[0].result,'published');await publish();
 assert.equal(await valid(),true);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM company_autonomy_release.payment_receipts')).rows[0].n,1);
 assert.equal((await db.query('SELECT amount_micro_usd FROM company_autonomy_release.payment_receipts')).rows[0].amount_micro_usd,5000000);
 assert.equal((await ingest()).rows[0].result,'duplicate');
});
test('same provider event replay with altered payload or identity conflicts durably and does not replace receipt',async t=>{
 const {db,ingest,publish}=await setup(t);await ingest();await publish();
 for(const override of [{digest:'d'.repeat(64)},{session:'cs_other'},{amount:501},{currency:'EUR'},{status:'refunded'},{payment:'00000000-0000-4000-8000-000000000004'},{qd:'d'.repeat(64)},{env:'live'},{tenant:'00000000-0000-4000-8000-000000000004'}]) await assert.rejects(ingest(override),/refused|conflict/i);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM current_autonomy_payment.events')).rows[0].n,1);
 assert.equal((await db.query('SELECT settled FROM company_autonomy_release.payment_receipts')).rows[0].settled,true);
});
test('independent completion events for one checkout converge; replay conflicts do not lose outbox',async t=>{
 const {db,ingest,publish}=await setup(t);
 const results=await Promise.all([ingest(),ingest(),ingest({id:'evt_async',digest:'d'.repeat(64)})]);
 assert.deepEqual(results.map(r=>r.rows[0].result).sort(),['duplicate','queued','queued']);
 await publish();await publish('evt_async');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM current_autonomy_payment.outbox WHERE delivered')).rows[0].n,2);
});
test('refund/cancel revocation is monotonic across old paid webhook retries and later distinct completion',async t=>{
 for(const status of ['refunded','cancelled']){
  const {db,ingest,publish,valid}=await setup(t);await ingest();await publish();assert.equal(await valid(),true);
  await ingest({id:'evt_revoke',digest:'d'.repeat(64),status});assert.equal(await valid(),false);
  assert.equal((await db.query('SELECT settled FROM company_autonomy_release.payment_receipts')).rows[0].settled,false);
  await ingest();await ingest({id:'evt_late',digest:'e'.repeat(64)});await publish('evt_late');assert.equal(await valid(),false);
 }
});
test('every read rechecks cancellation, current owner/environment, release revocation, latest quote, pricing contract and payment status',async t=>{
 for(const mutation of [
  `UPDATE jobs SET state='cancelled'`, `UPDATE jobs SET environment='live'`, `UPDATE jobs SET is_mock=true`,
  `UPDATE jobs SET workflow_run_id=null`, `UPDATE company_autonomy_release.job_bindings SET enabled=false`,
  `UPDATE company_autonomy_release.job_bindings SET owner_id='attacker'`,
  `UPDATE company_autonomy_release.job_bindings SET request=jsonb_set(request,'{job,environment}','\"live\"')`,
  `INSERT INTO customers(id,email) VALUES('00000000-0000-4000-8000-000000000004','other@example.invalid'); UPDATE jobs SET customer_id='00000000-0000-4000-8000-000000000004'`,
  `UPDATE quotes SET accepted_at=null`, `UPDATE quotes SET price_cents=501`, `UPDATE quotes SET pricing_mode='per_finding'`,
  `UPDATE quotes SET stripe_checkout_session_id='cs_other'`, `UPDATE payments SET status='needs_refund'`,
  `UPDATE payments SET currency='eur'`, `UPDATE payments SET amount_cents=501`,
  `INSERT INTO quotes(job_id,version,package,price_cents,scope_summary,deliverables) SELECT job_id,2,package,price_cents,scope_summary,deliverables FROM quotes LIMIT 1`,
 ]) {const {db,ingest,publish,valid}=await setup(t);await ingest();await publish();assert.equal(await valid(),true);await db.exec(mutation);assert.equal(await valid(),false,mutation);}
});
test('per-finding cap/authorization is explicitly refused rather than prepaid quote authority',async t=>{
 const {db,prepare,ingest}=await setup(t);
 await db.exec(`UPDATE quotes SET pricing_mode='per_finding',cap_cents=1500; UPDATE payments SET status='authorized'`);
 await assert.rejects(prepare(),/canonical_quote_refused/);await assert.rejects(ingest(),/canonical_quote_refused/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM current_autonomy_payment.events')).rows[0].n,0);
});
test('first binding can acquire canonical checkout session once, immutable quote/request identity cannot drift',async t=>{
 const {db,prepare}=await setup(t);await db.exec('DELETE FROM current_autonomy_payment.bindings');
 assert.equal((await prepare([undefined,undefined,undefined,undefined,undefined,undefined,undefined,null])).rows[0].result,'prepared');
 assert.equal((await prepare()).rows[0].result,'duplicate');
 await assert.rejects(prepare([undefined,undefined,undefined,'d'.repeat(64)]),/binding_replay_conflict/);
 await assert.rejects(prepare([undefined,undefined,undefined,undefined,'d'.repeat(64)]),/binding_replay_conflict/);
});
test('competing Stripe/x402 payment cannot grant either receipt authority or duplicate work',async t=>{
 const {db,ingest,publish,valid}=await setup(t);await ingest();await publish();
 await db.query(`INSERT INTO payments(job_id,quote_version,stripe_checkout_session_id,amount_cents,environment) VALUES($1,1,'x402:transaction',500,'test')`,[job]);
 assert.equal(await valid(),false);
});

test('failed verified event transaction leaves neither event nor delivery work behind',async t=>{
 const {db,ingest}=await setup(t);
 await assert.rejects(ingest({id:'x'.repeat(201)}),/check constraint/i);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM current_autonomy_payment.events')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM current_autonomy_payment.outbox')).rows[0].n,0);
});
