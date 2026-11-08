import { it, expect } from 'vitest';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAcceptanceDriver, OPERATION_PLAN } from '../../../docs/app-acceptance-integration/driver/createAcceptanceDriver.mjs';
it('refuses infeasible live operation plan before runtime access',async()=>{
 let reads=0;
 await expect(createAcceptanceDriver({limits:{target:32,gateway:16,naive:0,cloudMutation:0},get privateRuntimeRef(){reads++;throw Error('secret_read');}})).rejects.toThrow('operation_plan_exceeds_approved_caps');
 expect(reads).toBe(0);expect(OPERATION_PLAN.target).toBe(77);expect(OPERATION_PLAN.gateway).toBe(48);
});
it('real rich Text/remediation, SQL accounting and private artifact survive separate process restart',()=>{
 const stage=process.env.APP_ACCEPTANCE_STAGE!;
 const dir=mkdtempSync(join(stage,'offline-worker-'));
 try{
 const out=join(dir,'worker.mjs');
 buildSync({entryPoints:[join(stage,'tests/track-b/app-acceptance-integration/adapter-worker.ts')],outfile:out,bundle:true,platform:'node',format:'esm',packages:'external',alias:{'@ae/core':join(stage,'packages/core/src'),'@':join(stage,'apps/web/src'),'server-only':join(stage,'tests/track-b/app-acceptance-integration/empty.ts')},logLevel:'silent'});
 const run=(phase:string)=>JSON.parse(execFileSync(process.execPath,[out,join(dir,'sql'),phase,stage],{encoding:'utf8',timeout:60000}));
 const first=run('baseline'), restart=run('restart');
 expect(first.source).toBe('offline_fixture');expect(first.calendarCalls).toBe(52);expect(first.calendarBuggyFailures).toBe(2);expect(first.calendarFixedPassed).toBe(12);expect(restart.calendarCalls).toBe(0);expect(restart.calendarDigest).toBe(first.calendarDigest);expect(first.dispatches).toBe(25);expect(first.applied).toBe(12);
 expect(first.verification).toMatchObject({status:'verified',before:{passed:11,total:12},after:{passed:12,total:12},regressions:0});
 expect(restart.pid).not.toBe(first.pid);expect(restart.dispatches).toBe(0);expect(restart.proposals).toBe(0);expect(restart.reportDigest).toBe(first.reportDigest);
 expect(restart.operations).toBe(12);expect(restart.unknown).toBe(12);expect(restart.costRows).toBe(1);expect(restart.foreign).toBe(null);
 }finally{rmSync(dir,{recursive:true,force:true});}
},120000);
