import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stageComplete, overlaps } from './stage.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const { stage } = stageComplete({ applyMerge:false });
let patch = '';
for (const file of overlaps) {
  let diff;
  try { diff = execFileSync('diff',['-u','--label',`a/${file}`,'--label',`b/${file}`,join(stage,file),join(here,'source',file)],{encoding:'utf8'}); }
  catch (error) { if (error.status !== 1) throw error; diff = error.stdout; }
  patch += diff;
}
writeFileSync(join(here,'combined.patch'),patch);
