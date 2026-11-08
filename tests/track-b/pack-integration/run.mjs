import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline harness: dependencies must already exist. No installation, network or provider calls.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const dependencies = process.env.PACK_TEST_DEPENDENCIES ?? resolve(here, '../node_modules');
const git = args => {
  const result = spawnSync('git', args, {cwd:repo, encoding:'utf8', maxBuffer:16*1024*1024});
  if (result.status !== 0) throw new Error(result.stderr || 'local git read failed');
  return result.stdout;
};
const revision = git(['rev-parse','--verify','origin/track-a^{commit}']).trim();
const staging = await mkdtemp(join(tmpdir(),'pack-integration-'));
function run(program,args,env={}) {
  const result=spawnSync(process.execPath,[program,...args],{cwd:staging,stdio:'inherit',env:{...process.env,PACK_TRACK_A_REVISION:revision,...env}});
  if(result.status!==0) throw new Error(`Check failed: ${program} (${result.status})`);
}
try {
  await cp(join(repo,'packages/core/src'),join(staging,'packages/core/src'),{recursive:true});
  await cp(here,join(staging,'tests/track-b/pack-integration'),{recursive:true});
  for(const directory of ['contracts','redteam']) {
    const root=`packages/core/src/${directory}`;
    const paths=git(['ls-tree','-r','--name-only',revision,'--',root]).trim().split('\n').filter(p=>p.endsWith('.ts'));
    for(const path of paths) {
      await mkdir(dirname(join(staging,path)),{recursive:true});
      await writeFile(join(staging,path),git(['show',`${revision}:${path}`]));
    }
  }
  await symlink(dependencies,join(staging,'node_modules'),'dir');
  await writeFile(join(staging,'package.json'),JSON.stringify({type:'module',private:true}));
  await writeFile(join(staging,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,types:['node'],esModuleInterop:true},include:['packages/core/src/evals/packs/**/*.ts','tests/track-b/pack-integration/**/*.ts']}));
  run(join(dependencies,'typescript/bin/tsc'),['--project','tsconfig.json']);
  const files=(await readdir(here)).filter(f=>f.endsWith('.test.ts')).map(f=>`tests/track-b/pack-integration/${f}`);
  if(files.length<3) throw new Error('Expected contract, execution and secured port tests');
  run(join(dependencies,'vitest/vitest.mjs'),['run',...files,'packages/core/src/evals/integration/checkpoint.test.ts','packages/core/src/evals/text/__tests__/admission.test.ts','packages/core/src/evals/text/__tests__/rubric-admission.test.ts','--maxWorkers=1','--reporter=default']);
  console.log(`Pinned local Track A fixtures: ${revision}. Strict pack TypeScript and offline tests passed.`);
} finally { await rm(staging,{recursive:true,force:true}); }
