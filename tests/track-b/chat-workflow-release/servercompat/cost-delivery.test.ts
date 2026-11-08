import {beforeEach, expect, it, vi} from 'vitest';
import {deliverProductionDataCost} from '@data-cost';
import {toContractCost} from '@ae/core/evals/service-adapter';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const {recordCost}=vi.hoisted(()=>({recordCost:vi.fn()}));
vi.mock('@job-store',()=>({recordCost}));
const jobId='abcdefab-cdef-4abc-8def-abcdefabcdef';
const cost={jobId,source:'naive_session' as const,role:'evaluation_engineer' as const,externalId:'session-1',purpose:'data generation',microUsd:37,measured:true,recordedAt:'2026-11-07T00:00:00Z'};
beforeEach(()=>recordCost.mockReset());
it('delivers exact canonical Workflow payload and stable session key on retry',async()=>{
 await deliverProductionDataCost(jobId,cost,[]);
 await deliverProductionDataCost(jobId,structuredClone(cost),[]);
 expect(recordCost.mock.calls).toEqual([[{...toContractCost(cost),jobId}],[{...toContractCost(cost),jobId}]]);
 expect(recordCost.mock.calls[0][0].meta.idempotencyKey).toBe('naive:session-1');
});
it('keeps measured zero and propagates sink refusal for reconciliation',async()=>{
 await deliverProductionDataCost(jobId,{...cost,microUsd:0},[]);
 expect(recordCost.mock.calls[0][0].microUsd).toBe(0);
 recordCost.mockRejectedValueOnce(new Error('measured_cost_identity_conflict'));
 await expect(deliverProductionDataCost(jobId,cost,[])).rejects.toThrow('measured_cost_identity_conflict');
});
it.each([{...cost,jobId:'other'},{...cost,measured:false},{...cost,externalId:null},{...cost,purpose:'credential-super-secret'}])('rejects unsafe, unmeasured or foreign evidence before the sink',async raw=>{
 await expect(deliverProductionDataCost(jobId,raw,['credential-super-secret'])).rejects.toThrow();
 expect(recordCost).not.toHaveBeenCalled();
});
it('all retained data delivery paths use the shared sink, with no second cost writer',()=>{
 const source=readFileSync(join(process.env.SERVERCOMPAT_STAGE!,'apps/web/src/server/data-production.ts'),'utf8');
 expect(source).toContain('await deliverProductionDataCost(jobId, cost, secrets)');
 expect(source).not.toContain('INSERT INTO costs');
 expect(source).toContain('await s.drainDesignCosts()');
 expect(source).toContain('await s.deliverCost(result.cost)');
 expect(source).toContain('deliverCost: entry => s.deliverCost(entry.cost)');
});
