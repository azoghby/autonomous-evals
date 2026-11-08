#!/usr/bin/env node
// Offline only: uses existing local dependencies and disposable native PostgreSQL.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../..');
const deps=resolve(process.env.TRACK_B_NODE_MODULES??'/tmp/sandbox-generation-deps.cBCEai/node_modules');
const runtime=resolve(process.env.SANDBOX_PERSISTENCE_RUNTIME??'/tmp/agent-persistence-runtime');
const requireRuntime=createRequire(join(runtime,'package.json'));
const {default:EmbeddedPostgres}=await import(pathToFileURL(requireRuntime.resolve('embedded-postgres')));
const {Pool}=requireRuntime('pg');
const ref=process.env.TRACK_A_REF??'aa94505';
function git(args){const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;}
assert.ok(!ref.startsWith('-')&&!/[\0\r\n]/.test(ref));
const sha=git(['rev-parse','--verify','--end-of-options',`${ref}^{commit}`]).trim();
const spec=git(['show',`${sha}:packages/core/src/sandbox/spec.ts`]);
const work=await mkdtemp(join(tmpdir(),'sandbox-persistence-native-'));
let server;
try{
 const stage=join(work,'stage');await mkdir(stage);
 await cp(join(repo,'packages/core/src'),join(stage,'packages/core/src'),{recursive:true,filter:p=>! /\.(test|spec)\.ts$/.test(p)&&!p.includes('/src/sandbox')});
 await mkdir(join(stage,'packages/core/src/sandbox'),{recursive:true});await writeFile(join(stage,'packages/core/src/sandbox/spec.ts'),spec);
 const contracts=git(['ls-tree','-r','--name-only',sha,'--','packages/core/src/contracts']).trim().split('\n').filter(p=>p.endsWith('.ts')&&! /\.(test|spec)\.ts$/.test(p));
 for(const path of contracts){await mkdir(dirname(join(stage,path)),{recursive:true});await writeFile(join(stage,path),git(['show',`${sha}:${path}`]));}
 await cp(here,join(stage,'tests/track-b/sandbox-persistence'),{recursive:true,filter:p=>!p.endsWith('run.mjs')});
 await symlink(deps,join(stage,'node_modules'),'dir');await writeFile(join(stage,'package.json'),JSON.stringify({type:'module',private:true}));
 await writeFile(join(stage,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']},include:['tests/track-b/sandbox-persistence/**/*.ts','packages/core/src/evals/sandbox/persistence/**/*.ts']}));
 const typecheck=spawnSync(process.execPath,[join(deps,'typescript/bin/tsc'),'-p',join(stage,'tsconfig.json')],{cwd:stage,stdio:'inherit'});assert.equal(typecheck.status,0,'Strict typecheck failed');
 const reservation=createServer();await new Promise((ok,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',ok);});const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));
 const config={host:'127.0.0.1',port,user:'postgres',password:randomBytes(24).toString('hex'),database:'sandbox_persistence'};
 server=new EmbeddedPostgres({databaseDir:join(work,'data'),port,user:config.user,password:config.password,persistent:true,createPostgresUser:false,autoRehydrateSymlinks:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1','-k',work,'-c','fsync=on','-c','synchronous_commit=on','-c','full_page_writes=on'],onLog(){},onError(){}});
 await server.initialise();await server.start();await server.createDatabase(config.database);
 const pool=new Pool(config);try{await pool.query(await readFile(join(repo,'packages/core/src/evals/integration/migrations/001-text-integration.sql'),'utf8'));}finally{await pool.end();}
 console.log(`Native PostgreSQL ${JSON.parse(await readFile(join(runtime,'node_modules/embedded-postgres/package.json'),'utf8')).version}; exact Track A ${sha}, spec sha256:${createHash('sha256').update(spec).digest('hex')}; local loopback only, no network/provider/cloud calls.`);
 let total=0;
 for(const name of ['restart-seed.test.ts','persistence.test.ts']){
  if(name==='persistence.test.ts'){await server.stop();await server.start();console.log('Native PostgreSQL stopped and restarted; new test worker and pools.');}
  const output=join(stage,`${name}.json`),r=spawnSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run',`tests/track-b/sandbox-persistence/${name}`,'--root',stage,'--maxWorkers=1','--reporter=json',`--outputFile=${output}`],{cwd:stage,encoding:'utf8',env:{...process.env,SANDBOX_PERSISTENCE_RUNTIME:runtime,SANDBOX_PERSISTENCE_CONFIG:JSON.stringify(config)},maxBuffer:4*1024*1024});
  const scrub=s=>s.replaceAll(config.password,'[redacted]');if(r.status!==0)console.error(scrub(`${r.stdout}\n${r.stderr}`));
  const results=JSON.parse(await readFile(output,'utf8'));
  for(const file of results.testResults)for(const test of file.assertionResults)if(test.status!=='passed')console.error(test.fullName,scrub(test.failureMessages.join('\n')));
  assert.equal(r.status,0,'Native SQL tests failed');assert.ok(results.numPassedTests>0);assert.equal(results.numPendingTests,0);assert.equal(results.numFailedTests,0);total+=results.numPassedTests;
 }
 console.log(`PASS: strict typecheck; ${total} native SQL tests; independent connections and full server restart; zero skipped. No provider/live engine acceptance claimed.`);
}finally{
 if(server?.process)await server.stop();if(!server?.process)await rm(work,{recursive:true,force:true});
}
