import {cp,mkdir,mkdtemp,symlink,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const deps=process.env.AUTONOMY_NODE_MODULES ?? '/tmp/autonomous-evals-checks.m10du4/node_modules';
const stage=await mkdtemp(join(tmpdir(),'company-autonomy-'));
try {
 await cp(join(repo,'packages/core/src'),join(stage,'packages/core/src'),{recursive:true});
 await cp(join(repo,'tests/track-b/autonomous-company'),join(stage,'tests/track-b/autonomous-company'),{recursive:true});
 // Accounting imports the shared service contracts; stage exact owner blobs read-only.
 const contractRef='875ceef6a743df41736ee55c4145ca794e0854a8';
 const listed=spawnSync('git',['ls-tree','-r','--name-only',contractRef,'packages/core/src/contracts'],{cwd:repo,encoding:'utf8'});
 if(listed.status!==0)throw new Error('contract inventory unavailable');
 const files=listed.stdout.trim().split('\n').filter(p=>p.endsWith('.ts')&&!p.endsWith('.test.ts'));
 if(!files.length)throw new Error('shared contracts missing');
 for(const file of files){
  if(!/^packages\/core\/src\/contracts\/[A-Za-z0-9_./-]+\.ts$/.test(file)||file.includes('..'))throw new Error('unsafe contract path');
  const blob=spawnSync('git',['show',`${contractRef}:${file}`],{cwd:repo});
  if(blob.status!==0)throw new Error('contract blob unavailable');
  await mkdir(dirname(join(stage,file)),{recursive:true});await writeFile(join(stage,file),blob.stdout);
 }
 console.log(`Read-only contracts: ${contractRef}`);

 await cp(join(repo,'docs/autonomous-company-integration/application.patch'),join(stage,'application.patch'));
 const apply=spawnSync('git',['apply','--check','application.patch'],{cwd:stage,encoding:'utf8'});if(apply.status!==0)throw new Error(apply.stderr);
 const applied=spawnSync('git',['apply','application.patch'],{cwd:stage,encoding:'utf8'});if(applied.status!==0)throw new Error(applied.stderr);
 const exact=await readFile(join(repo,'docs/autonomous-company-integration/source/apps/web/src/server/autonomous-company.ts'),'utf8');
 if(await readFile(join(stage,'apps/web/src/server/autonomous-company.ts'),'utf8')!==exact)throw new Error('application patch drift');
 await symlink(deps,join(stage,'node_modules'),'dir');
 await writeFile(join(stage,'server-only.d.ts'),"declare module 'server-only';\n");
 await writeFile(join(stage,'package.json'),'{"type":"module"}');
 await writeFile(join(stage,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*']}},include:['server-only.d.ts','tests/track-b/autonomous-company/**/*.ts','apps/web/src/server/autonomous-company.ts']}));
 for(const [tool,args] of [['typescript/bin/tsc',['-p','tsconfig.json']],['vitest/vitest.mjs',['run','tests/track-b/autonomous-company','--maxWorkers=1','--reporter=default','--reporter=json',`--outputFile.json=${stage}/results.json`]]]) {
  const r=spawnSync(process.execPath,[join(deps,tool),...args],{cwd:stage,stdio:'inherit'});
  if(r.status!==0) throw new Error(`${tool} failed (${r.status})`);
 }
 const r=JSON.parse(await readFile(join(stage,'results.json'),'utf8'));
 if(r.numPendingTests || r.numFailedTests || !r.numPassedTests)throw new Error('incomplete acceptance');
 console.log(JSON.stringify({tests:r.numPassedTests,files:r.testResults.length,skipped:r.numPendingTests,providers:'offline fake only',sql:'PGlite PostgreSQL'},null,2));
} finally {await rm(stage,{recursive:true,force:true});}
