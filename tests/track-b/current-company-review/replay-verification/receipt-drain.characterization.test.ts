/** CHARACTERIZATION (passing; NOT acceptance). Controls for RV-1 over the same real SQL + actual bridge. */
import {afterEach,expect,it} from 'vitest';
import {paymentFixture} from './payment-fixture';

const dbs:Array<{close():Promise<void>}>=[];
afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});

it('CHARACTERIZATION: with 24 stuck jobs the same late receipt drains on the first tick (the 25-job window is the cause)',async()=>{
 const f=await paymentFixture();dbs.push(f.db);
 for(let n=1;n<=24;n++)await f.refundedJob(n);
 const healthy=await f.job(1000,'ffffffff');
 await f.ingest(healthy.tenant,healthy.id,'evt_late','paid',healthy.session,healthy.payment);
 const {outcomes}=await f.bridge.drainPendingReceipts();
 expect(outcomes).toHaveLength(25);expect(outcomes.at(-1)).toEqual({jobId:healthy.id,checked:1});
 expect(await f.published(healthy.tenant,healthy.id,'evt_late')).toBe(true);
},60000);
it('CHARACTERIZATION: a refund event outbox row is never marked delivered; each tick re-selects that job (permanent drain-window occupant)',async()=>{
 const f=await paymentFixture();dbs.push(f.db);const j=await f.refundedJob(1);
 for(let tick=0;tick<3;tick++)expect((await f.bridge.drainPendingReceipts()).outcomes).toEqual([{jobId:j.id,checked:1}]);
 expect(await f.undelivered()).toBe(1);expect(await f.valid(j.tenant,j.id,'evt_pay_1')).toBe(false);
 // Bootstrap's per-job drain is the only path that still works for an affected later job.
 expect(await f.publish(j.tenant,j.id,'evt_refund_1')).toBe('waiting_or_revoked');
},60000);
