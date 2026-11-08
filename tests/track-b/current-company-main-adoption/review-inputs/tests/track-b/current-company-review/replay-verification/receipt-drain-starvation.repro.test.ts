/** REPRO (expected to FAIL today; RV-1). Real SQL + actual composed bridge.drainPendingReceipts, which
 * createCurrentPaymentStartup.advanceDueJobs runs before every autonomous scheduler tick.
 * HANDOFF claim under test: "Pending receipt draining is bounded before every autonomous scheduler tick,
 * so receipts arriving after bootstrap do not stall indefinitely." */
import {afterEach,expect,it} from 'vitest';
import {paymentFixture} from './payment-fixture';

const dbs:Array<{close():Promise<void>}>=[];
afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});

it('RV-1: a receipt arriving after bootstrap is eventually drained by scheduler ticks even when 25 earlier jobs hold permanently undeliverable (refund) outbox rows',async()=>{
 const f=await paymentFixture();dbs.push(f.db);
 for(let n=1;n<=25;n++)await f.refundedJob(n);
 expect(await f.undelivered()).toBe(25);
 // Healthy job: bootstrapped (release binding exists); its verified paid receipt arrives afterwards.
 const healthy=await f.job(1000,'ffffffff');
 expect(await f.ingest(healthy.tenant,healthy.id,'evt_late','paid',healthy.session,healthy.payment)).toBe('queued');
 expect(await f.valid(healthy.tenant,healthy.id,'evt_late')).toBe(true); // publishable now
 for(let tick=0;tick<5;tick++)await f.bridge.drainPendingReceipts();
 expect(await f.published(healthy.tenant,healthy.id,'evt_late')).toBe(true);
},60000);
