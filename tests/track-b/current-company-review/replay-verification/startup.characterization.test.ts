/** CHARACTERIZATION (passing; NOT acceptance). Records current createCurrentIsolateStartup cache behavior
 * so a reviewer/owner can decide whether it matches "only configuration is cached". */
import {expect,it,vi} from 'vitest';
vi.mock('@/server/current-stripe-payment',()=>({currentStripePaymentOptions:(o:unknown)=>o}));
vi.mock('@/server/current-payment',()=>({createCurrentPaymentBridge:()=>({})}));
vi.mock('@/server/current-autonomy',()=>({createCurrentAutonomyApplication:()=>({})}));
import {createCurrentIsolateStartup,type CurrentOwnerAdapters} from '@/server/current-payment-startup';
const adapters=()=>{const sql={};return {config:{db:sql},bridge:{sql},dependencies:{viewer:vi.fn()},enqueue:vi.fn(),enqueueQuote:vi.fn(),exclusiveDispatch:vi.fn()} as unknown as CurrentOwnerAdapters;};

it('CHARACTERIZATION: a resolved "blocked" owner status is cached for the isolate lifetime; the loader is not consulted again',async()=>{
 const load=vi.fn().mockResolvedValueOnce({status:'blocked',missing:['provider_receipts']}).mockResolvedValue({status:'ready',adapters:adapters()});
 const get=createCurrentIsolateStartup(load);
 expect(await get()).toBeNull();expect(await get()).toBeNull();expect(load).toHaveBeenCalledOnce();
});
it('CHARACTERIZATION: a resolved "ready" startup is cached; a later blocked loader answer is not observed in the same isolate',async()=>{
 const load=vi.fn().mockResolvedValueOnce({status:'ready',adapters:adapters()}).mockResolvedValue({status:'blocked',missing:['revoked']});
 const get=createCurrentIsolateStartup(load);
 const first=await get();expect(first).toBeTruthy();expect(await get()).toBe(first);expect(load).toHaveBeenCalledOnce();
});
