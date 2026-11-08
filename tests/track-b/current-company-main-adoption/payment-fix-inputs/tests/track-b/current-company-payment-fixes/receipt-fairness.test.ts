import {expect,it} from 'vitest';
import {createCurrentPaymentBridge} from '@/server/current-payment';
import {paymentFixture} from '../current-company-review/replay-verification/payment-fixture';

it('temporarily unauthorized jobs rotate behind unattempted payments even with a frozen clock, then recover without data loss',async()=>{
 const f=await paymentFixture();
 try {
  let restored=false;
  const bridge=createCurrentPaymentBridge({sql:f.sql,now:()=>0,
   authorize:async p=>restored || p.tenantId.startsWith('ffffffff'),
   verifyStripe:()=>{throw new Error('no provider access');}});
  for(let n=1;n<=25;n++){
   const j=await f.job(n,'00000000');
   expect(await f.ingest(j.tenant,j.id,'evt_wait_'+n,'paid',j.session,j.payment)).toBe('queued');
  }
  const healthy=await f.job(1000,'ffffffff');
  expect(await f.ingest(healthy.tenant,healthy.id,'evt_healthy','paid',healthy.session,healthy.payment)).toBe('queued');
  const first=await bridge.drainPendingReceipts();
  expect(first.outcomes).toHaveLength(25);
  expect(first.outcomes.every(o=>'blocked' in o && o.blocked)).toBe(true);
  expect(await f.undelivered()).toBe(26);
  expect(await f.published(healthy.tenant,healthy.id,'evt_healthy')).toBe(false);
  const second=await bridge.drainPendingReceipts();
  expect(second.outcomes[0]).toEqual({jobId:healthy.id,checked:1});
  expect(await f.published(healthy.tenant,healthy.id,'evt_healthy')).toBe(true);
  expect(await f.undelivered()).toBe(25);
  // Failed authorization never retires valid payments. Restoring authority drains them normally.
  restored=true;
  await bridge.drainPendingReceipts();
  expect(await f.undelivered()).toBe(0);
  const receipts=await f.db.query<{count:number}>('SELECT count(*)::int AS count FROM company_autonomy_release.payment_receipts');
  expect(receipts.rows[0].count).toBe(26);
 } finally {await f.db.close();}
},60000);
