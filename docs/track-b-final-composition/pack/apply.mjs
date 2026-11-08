import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)), root=resolve(here,'../../..');
const sources={
 'rich-services.ts':'apps/web/src/server/rich-services.ts',
 'rich-evaluation.ts':'apps/web/src/workflows/steps/rich-evaluation.ts',
 'workflow-packs.ts':'apps/web/src/server/workflow-packs.ts',
 'route.ts':'apps/web/src/app/api/operator/jobs/[jobId]/workflow-pack/route.ts',
};
export function applyPack(stage) {
 for(const [patch,excluded] of [
  ['projection/003-pack-projection.patch',[]],
  ['execution/003-pack-execution.patch',Object.values(sources)],
 ]) {
  const path=join(root,'docs/workflow-pack-integration',patch);
  const args=excluded.map(path=>`--exclude=${path}`);
  try {
   execFileSync('git',['apply','--check',...args,path],{cwd:stage});
   execFileSync('git',['apply',...args,path],{cwd:stage});
  } catch(error) {throw new Error(`Pack composition failed at ${patch}: rebuild a clean stageComplete() tree before applyPack(); ${error.message}`);}
 }
 for(const [source,target] of Object.entries(sources)) {
  const dest=join(stage,target);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(here,'source',source),dest);
 }
 return {stage,packComposition:Object.values(sources)};
}
