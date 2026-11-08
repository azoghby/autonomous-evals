import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const deps = process.env.AUTONOMY_NODE_MODULES ?? ['/tmp/sandbox-generation-deps.cBCEai/node_modules','/tmp/workflow-bootstrap.JpxCTM/node_modules'].find(p=>existsSync(resolve(p,'@electric-sql/pglite/dist/index.js')));
if (!deps) throw new Error('offline_pglite_dependencies_required');
const { PGlite } = await import(pathToFileURL(resolve(deps,'@electric-sql/pglite/dist/index.js')).href);
const sql = readFileSync(new URL('../../../docs/autonomy-release-adoption/source/apps/web/src/server/autonomy-release.sql',import.meta.url),'utf8');
const digest='a'.repeat(64);
async function setup(t) {
 const db=new PGlite();t.after(()=>db.close());await db.exec(sql);
 await db.query(`INSERT INTO company_autonomy_release.job_bindings(tenant_id,job_id,owner_id,policy_version,request,enabled,next_tick_at) VALUES('tenant','job','owner','v1','{}',true,1)`);
 return db;
}
test('additive migration is idempotent and preserves bindings across reapplication',async t=>{
 const db=await setup(t);await db.exec(sql);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM company_autonomy_release.job_bindings')).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM company_autonomy_release.job_bindings WHERE enabled AND next_tick_at <= 1")).rows[0].n,1);
});
test('tenant/job composite foreign keys reject source, payment and provider evidence crossing tenants',async t=>{
 const db=await setup(t);
 await assert.rejects(db.query(`INSERT INTO company_autonomy_release.source_permissions VALUES('other','job','source',$1,true,100)`,[digest]),/foreign key/i);
 await assert.rejects(db.query(`INSERT INTO company_autonomy_release.payment_receipts(tenant_id,job_id,receipt_id,settled,amount_micro_usd,record) VALUES('other','job','payment',true,100,$1)`,[JSON.stringify({quoteDigest:digest})]),/foreign key/i);
 await assert.rejects(db.query(`INSERT INTO company_autonomy_release.provider_receipts VALUES('other','job','action','provider','{}')`),/foreign key/i);
});
test('unknown payment cannot masquerade as settled or lose exact quote identity',async t=>{
 const db=await setup(t);
 const insert=(id,settled,amount,record,currency='USD')=>db.query(`INSERT INTO company_autonomy_release.payment_receipts(tenant_id,job_id,receipt_id,settled,amount_micro_usd,record,currency) VALUES('tenant','job',$1,$2,$3,$4,$5)`,[id,settled,amount,JSON.stringify(record),currency]);
 await assert.rejects(insert('unknown',true,null,{quoteDigest:digest}),/check constraint/i);
 await assert.rejects(insert('negative',true,-1,{quoteDigest:digest}),/check constraint/i);
 await assert.rejects(insert('unbound',true,1,{}),/check constraint/i);
 await assert.rejects(insert('currency',true,1,{quoteDigest:digest},'EUR'),/check constraint/i);
 await insert('pending',false,null,{quoteDigest:digest});
 assert.equal((await db.query('SELECT settled FROM company_autonomy_release.payment_receipts')).rows[0].settled,false);
});
test('permission evidence requires exact digest and bounded expiry; no implicit default permission',async t=>{
 const db=await setup(t);
 await assert.rejects(db.query(`INSERT INTO company_autonomy_release.source_permissions VALUES('tenant','job','source','model says yes',true,100)`),/check constraint/i);
 await assert.rejects(db.query(`INSERT INTO company_autonomy_release.source_permissions VALUES('tenant','job','source',$1,true,-1)`,[digest]),/check constraint/i);
 await db.query(`INSERT INTO company_autonomy_release.source_permissions VALUES('tenant','job','source',$1,false,100)`,[digest]);
 assert.equal((await db.query(`SELECT count(*)::int AS n FROM company_autonomy_release.source_permissions WHERE allowed AND expires_at > 0`)).rows[0].n,0);
});
test('public has neither schema nor table authority and cannot read or write as a customer role',async t=>{
 const db=await setup(t);
 await db.exec('CREATE ROLE autonomy_release_customer; SET ROLE autonomy_release_customer');
 await assert.rejects(db.query('SELECT * FROM company_autonomy_release.job_bindings'),/permission denied/i);
 await assert.rejects(db.query(`INSERT INTO company_autonomy_release.job_bindings VALUES('attacker','job','attacker','v1','{}',true,0)`),/permission denied/i);
 await db.exec('RESET ROLE');
});
test('schema contains no alternative monetary ledger or legacy human review authority',()=>{
 assert.doesNotMatch(sql,/CREATE TABLE[^;]*(?:budget|review|publication)/i);
 assert.match(sql,/SAME PostgresBudgetLedger/);
 assert.match(sql,/REVOKE ALL ON ALL TABLES/);
});
