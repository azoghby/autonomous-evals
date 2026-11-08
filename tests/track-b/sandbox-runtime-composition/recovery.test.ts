import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { connection, storage, policy, scenario, publishActual, binding } from './helpers';
import { createDurableRuntimeComposition } from '../../../packages/core/src/evals/sandbox/runtime-composition';
import { gradeSandbox } from '../../../packages/core/src/evals/sandbox/grading';
import type { SandboxEngineAuthority } from '../../../packages/core/src/evals/sandbox/integration';
import type { SnapshotArtifact } from '../../../packages/core/src/evals/sandbox/runtime-bridge';
const artifact=async()=>JSON.parse(await readFile(process.env.COMPOSITION_ARTIFACT!,'utf8')) as SnapshotArtifact;
it('actual engine authority shape restores exact SQL and grades after process and PostgreSQL restart without allocation',async()=>{
 const c=connection();try{
  const composed=createDurableRuntimeComposition({storage:storage(c.db),resolvePolicy:async b=>policy(b),synchronousReadGuard:()=>true});
  const finalSnapshot:SandboxEngineAuthority['finalSnapshot']=composed.finalSnapshot;
  const a=await artifact(),snap=await finalSnapshot(a as Parameters<typeof finalSnapshot>[0]);expect(snap).not.toBeNull();
  try{expect(snap!.run.runId).toBe(a.runId);expect(await snap!.run.query('SELECT count(*)::int AS n FROM hidden.entries WHERE value=$1',['approved'])).toEqual([{n:8}]);const g=await gradeSandbox({...snap!.evidence,run:snap!.run,scenario,versions:a.input.versions,transcript:[]});expect(g.checks.find(c=>c.id==='collateral')?.verdict).toBe('pass');}finally{await snap!.release();}
  await expect(composed.finalSnapshot({...a,worldId:'foreign'})).rejects.toThrow();await expect(composed.finalSnapshot({...a,toolCalls:[{seq:0,tool:'fabricated',args:{},result:null,ms:0}]})).rejects.toThrow();
 }finally{await c.close();}
});
it('fresh ownership and retired-secret checks remain active after recovery',async()=>{
 const c=connection();let authorized=true,secrets:string[]=[];try{
  const composed=createDurableRuntimeComposition({storage:storage(c.db,{authorize:async()=>authorized,knownSecrets:()=>secrets}),resolvePolicy:async b=>policy(b),synchronousReadGuard:()=>authorized&&secrets.length===0});
  const a=await artifact(),snap=await composed.finalSnapshot(a);try{
   authorized=false;const revokedGrade=await gradeSandbox({...snap!.evidence,run:snap!.run,scenario,versions:a.input.versions,transcript:[]});expect(revokedGrade.checks.find(c=>c.id==='collateral')?.verdict).toBe('unknown');await expect(snap!.run.query('SELECT 1')).rejects.toThrow();expect(()=>snap!.run.trajectory()).toThrow();await expect(composed.finalSnapshot(a)).rejects.toThrow();
   authorized=true;secrets=['approved'];await expect(snap!.run.query('SELECT value FROM hidden.entries')).rejects.toThrow();await expect(composed.finalSnapshot(a)).rejects.toThrow();
  }finally{await snap!.release();}
 }finally{await c.close();}
});
it('missing independently issued row authority remains unknown at composed finalSnapshot',async()=>{
 const c=connection();try{
  const s=storage(c.db),saved=await publishActual(s,'composed-no-policy',{resolvePolicy:async()=>null}),a=await artifact(),b=binding('composed-no-policy');
  const composed=createDurableRuntimeComposition({storage:s,resolvePolicy:async()=>null,synchronousReadGuard:()=>true});
  const snap=await composed.finalSnapshot({...a,runId:b.runId,worldId:b.worldId,identityDigest:b.executionIdentity,...saved.receipts});
  try{const g=await gradeSandbox({...snap!.evidence,run:snap!.run,scenario,versions:b.versions,transcript:[]});expect(g.checks.find(c=>c.id==='collateral')?.verdict).toBe('unknown');}finally{await snap!.release();}
 }finally{await c.close();}
});
