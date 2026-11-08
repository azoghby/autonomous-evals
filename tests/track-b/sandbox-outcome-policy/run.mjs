import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const deps=process.env.TRACK_B_NODE_MODULES ?? '/tmp/workflow-bootstrap.JpxCTM/node_modules';
const stage=await mkdtemp(join(tmpdir(),'sandbox-outcome-policy-'));
try {
 const ref=process.env.TRACK_A_REF??'875ceef';
 if(ref.startsWith('-')||/[\0\r\n]/.test(ref))throw Error('Invalid contract ref');
 const pin=execFileSync('git',['rev-parse','--verify','--end-of-options',`${ref}^{commit}`],{cwd:repo,encoding:'utf8'}).trim();
 const archive=execFileSync('git',['archive',pin,'packages/core/src'],{cwd:repo,maxBuffer:64*1024*1024});
 execFileSync('tar',['-x','-C',stage],{input:archive});
 const sandboxRoot=join(stage,'packages/core/src/sandbox');
 const retained=new Map();
 for(const entry of await readdir(sandboxRoot,{recursive:true,withFileTypes:true}))if(entry.isFile()){const path=join(entry.parentPath,entry.name);retained.set(path,await readFile(path));}
 await cp(join(repo,'packages/core/src'),join(stage,'packages/core/src'),{recursive:true,filter:path=>!path.includes('/src/sandbox')&&!/\.(test|spec)\.ts$/.test(path)});
 for(const [path,bytes]of retained)if(!(await readFile(path)).equals(bytes))throw Error('A sandbox source overwritten');
 console.log(`Preserved ${retained.size} exact A sandbox source files, including any engine/media/runtime additions.`);
 await mkdir(join(stage,'tests/track-b'),{recursive:true});
 await cp(join(repo,'tests/track-b/sandbox-integration'),join(stage,'tests/track-b/sandbox-integration'),{recursive:true});
 await cp(join(repo,'tests/track-b/sandbox-media-integration'),join(stage,'tests/track-b/sandbox-media-integration'),{recursive:true});
 await cp(join(repo,'tests/track-b/sandbox-outcome-policy'),join(stage,'tests/track-b/sandbox-outcome-policy'),{recursive:true});
 await mkdir(join(stage,'node_modules'));
 for (const name of await readdir(deps)) { const source=name==='ipaddr.js'?(process.env.TRACK_B_IPADDR_MODULE??'/tmp/sandbox-generation-deps.cBCEai/node_modules/ipaddr.js'):join(resolve(deps),name); await symlink(source,join(stage,'node_modules',name)); }
 await writeFile(join(stage,'package.json'),'{"private":true,"type":"module"}');
 await writeFile(join(stage,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,esModuleInterop:true,types:['node'],noEmit:true},include:['tests/track-b/sandbox-outcome-policy/*.ts','tests/track-b/sandbox-media-integration/*.ts','tests/track-b/sandbox-integration/*.ts','packages/core/src/evals/sandbox/multimodal/**/*.ts']}));
 console.log(`Staged exact A media/spec ${pin}; no checkout A modifications.`);
 execFileSync(process.execPath,[join(deps,'typescript/bin/tsc'),'-p',join(stage,'tsconfig.json')],{cwd:stage,stdio:'inherit'});
 execFileSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','tests/track-b/sandbox-outcome-policy','tests/track-b/sandbox-media-integration','tests/track-b/sandbox-integration','--root',stage,'--maxWorkers=1','--reporter=json','--outputFile=results.json'],{cwd:stage,stdio:'inherit'});
 const results=JSON.parse(await readFile(join(stage,'results.json'),'utf8'));
 if(!results.numPassedTests||results.numFailedTests||results.numPendingTests||results.testResults.some(f=>f.assertionResults.some(t=>t.status!=='passed')))throw Error('Incomplete test execution');
 console.log(`Strict TypeScript; ${results.numPassedTests} offline tests passed, zero skipped. Actual A SQL/runtime and retained image; no live/provider acceptance.`);
}catch(error){
 try {const results=JSON.parse(await readFile(join(stage,'results.json'),'utf8')); for(const file of results.testResults)for(const test of file.assertionResults)if(test.status!=='passed')console.error(test.fullName,test.failureMessages);}catch{}
 throw error;
}finally{await rm(stage,{recursive:true,force:true});}
