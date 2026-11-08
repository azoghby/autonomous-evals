import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({mutate:(p:any)=>{},revision:1}));
// Capture the exact app read boundary; core's defensive clone remains the input contract.
vi.mock('@ae/core/reporting/chat/projection/index',()=>({
 createDurableProgressReader:(port:any)=>({read:async(plan:any)=>{const requested=structuredClone(plan);state.mutate(requested);return port.withRead(requested,async()=>({accepted:true}));}}),
 createDurableProgressProjection:(ports:any)=>({read:async(scope:any)=>ports.reader.read(await ports.resolve(scope))})
}));
import {readStructuredProgress} from '@/server/structured-progress';
const jobId='11111111-1111-4111-8111-111111111111';
const plan={checkpoints:[{key:{jobId,kind:'design',id:'suite',inputDigest:'a'.repeat(64)},phase:'planning',format:'text_design'}],acquisitionTaskIds:[]};
const scope={subjectId:'viewer',jobId};const job={id:jobId,customer_id:'tenant',state:'running',updated_at:'2026-11-07T10:00:00.000Z'};
function tx(){let calls=0;return {query:async(sql:string)=>{if(sql.startsWith('SELECT package'))return {rows:[{package:'text_eval',environment:'test'}]};return {rows:[{tenant_id:'tenant',job_id:jobId,environment:'test',revision:++calls===1?1:state.revision,plan:structuredClone(plan),observed_at:job.updated_at}]};}};}
const call=()=>readStructuredProgress(tx(),scope,job,Buffer.alloc(32,9),[]);
beforeEach(()=>{state.mutate=()=>{};state.revision=1;});
it('accepts an exact defensive plan clone at the pinned read boundary',async()=>{expect(await call()).toEqual({accepted:true});});
it.each(['scope','environment','checkpoint','acquisition'])('rejects changed %s in a cloned plan',async kind=>{
 state.mutate=p=>{if(kind==='scope')p.scope.subjectId='foreign';if(kind==='environment')p.environment='live';if(kind==='checkpoint')p.checkpoints[0].key.inputDigest='b'.repeat(64);if(kind==='acquisition')p.acquisitionTaskIds.push('foreign-task');};
 await expect(call()).rejects.toMatchObject({code:'invalid_snapshot'});
});
it('retains durable revision fence even for an otherwise exact plan clone',async()=>{state.revision=2;await expect(call()).rejects.toMatchObject({code:'invalid_snapshot'});});
