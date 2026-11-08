import { cp, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)), repo=resolve(here,'../../..');
const deps=process.argv[2];
if(!deps) throw new Error('Usage: node tests/track-b/sandbox-execution/check.mjs /absolute/path/to/node_modules');
const stage=await mkdtemp(join(tmpdir(),'sandbox-execution-'));
try {
  await cp(join(repo,'packages/core/src'),join(stage,'src'),{recursive:true,filter:p=>!p.endsWith('.test.ts')});
  await mkdir(join(stage,'src/sandbox'),{recursive:true});
  const spec=execFileSync('git',['show','aa94505:packages/core/src/sandbox/spec.ts'],{cwd:repo});
  await writeFile(join(stage,'src/sandbox/spec.ts'),spec);
  // Existing reused facilities depend on the historical core contracts; stage those unchanged too.
  const files=execFileSync('git',['ls-tree','-r','--name-only','aa94505','--','packages/core/src/contracts'],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  for(const f of files) { const dest=join(stage,'src',f.slice('packages/core/src/'.length));await mkdir(dirname(dest),{recursive:true});await writeFile(dest,execFileSync('git',['show',`aa94505:${f}`],{cwd:repo})); }
  await mkdir(join(stage,'tests')); await cp(join(here,'execution.test.ts'),join(stage,'tests/execution.test.ts'));
  await symlink(resolve(deps),join(stage,'node_modules'));
  await writeFile(join(stage,'package.json'),'{"type":"module","private":true}');
  await writeFile(join(stage,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']},include:['tests/**/*.ts','src/evals/sandbox/execution/**/*.ts']}));
  execFileSync(process.execPath,[join(stage,'node_modules/typescript/bin/tsc'),'--project',join(stage,'tsconfig.json')],{cwd:stage,stdio:'inherit'});
  execFileSync(process.execPath,[join(stage,'node_modules/vitest/vitest.mjs'),'run','tests/execution.test.ts','--maxWorkers=1'],{cwd:stage,stdio:'inherit'});
  console.log('Pinned exact aa94505 spec; strict typecheck and offline execution tests passed. No live provider/runtime acceptance claimed.');
} finally {await rm(stage,{recursive:true,force:true});}
