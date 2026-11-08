import {it,expect} from 'vitest';
import {readFileSync as read} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const stage=process.env.WORKFLOW_STAGE!;
const hash=(path:string)=>createHash('sha256').update(read(join(stage,path))).digest('hex');
it('extends exact current artifact; preserves every frozen base byte except explicit owner postimages',()=>{
 const base=JSON.parse(read(join(stage,'CURRENT-COMPOSITION.json'),'utf8'));
 const payment=JSON.parse(read(join(stage,'PAYMENT-COMPOSITION.json'),'utf8'));
 expect(payment.artifact).toBe('f88811c8fb7509dc5996bb8cd1d148e4c23f3de3');
 expect(base.parent).toBe('039851736eabb94e85c2c111bbccc78374716275');
 for(const [path,entry] of Object.entries({...base.preserved,...base.changes,...base.additions}) as [string,{sha256:string}][])
  expect(hash(path),path).toBe(payment.changes[path]?.sha256??payment.reviewChanges?.[path]?.sha256??entry.sha256);
 expect(Object.keys(payment.changes).filter(p=>base.preserved[p])).toEqual(['apps/web/src/app/api/stripe/webhook/route.ts']);
 expect(payment.releaseAccepted).toBe(false);expect(payment.liveRunPerformed).toBe(false);
});
