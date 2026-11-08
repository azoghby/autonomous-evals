import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const deps=process.env.TRACK_B_NODE_MODULES ?? '/tmp/workflow-bootstrap.JpxCTM/node_modules';
const stage=await mkdtemp(join(tmpdir(),'sandbox-multimodal-'));
try {
 const pin=execFileSync('git',['rev-parse','875ceef^{commit}'],{cwd:repo,encoding:'utf8'}).trim();
 const archive=execFileSync('git',['archive',pin,'packages/core/src'],{cwd:repo,maxBuffer:64*1024*1024});
 execFileSync('tar',['-x','-C',stage],{input:archive});
 await cp(join(repo,'packages/core/src/evals/sandbox/multimodal'),join(stage,'packages/core/src/evals/sandbox/multimodal'),{recursive:true});
 await mkdir(join(stage,'tests/track-b'),{recursive:true});
 await cp(join(repo,'tests/track-b/sandbox-multimodal'),join(stage,'tests/track-b/sandbox-multimodal'),{recursive:true});
 await mkdir(join(stage,'node_modules'));
 for (const name of await readdir(deps)) { const source=name==='ipaddr.js'?(process.env.TRACK_B_IPADDR_MODULE??'/tmp/sandbox-generation-deps.cBCEai/node_modules/ipaddr.js'):join(resolve(deps),name); await symlink(source,join(stage,'node_modules',name)); }
 await writeFile(join(stage,'package.json'),'{"private":true,"type":"module"}');
 await writeFile(join(stage,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,esModuleInterop:true,types:['node'],outDir:'out'},include:['tests/track-b/sandbox-multimodal/*.ts','packages/core/src/evals/sandbox/multimodal/**/*.ts']}));
 console.log(`Staged exact A media/spec ${pin}; no checkout A modifications.`);
 execFileSync(process.execPath,[join(deps,'typescript/bin/tsc'),'-p',join(stage,'tsconfig.json')],{cwd:stage,stdio:'inherit'});
 // Node ESM requires extensions; only emitted JS is rewritten, never staged A source.
 for (const entry of await readdir(join(stage,'out'),{recursive:true})) { if(!entry.endsWith('.js')) continue; const path=join(stage,'out',entry); const code=await readFile(path,'utf8'); await writeFile(path,code.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,(_all,lead,q,spec)=>lead+q+(spec.endsWith('.js')?spec:spec+'.js')+q)); }
 execFileSync(process.execPath,['--test',...['common','voice','vision','bridge'].map(name=>join(stage,`out/tests/track-b/sandbox-multimodal/${name}.test.js`))],{cwd:stage,stdio:'inherit'});
}finally{await rm(stage,{recursive:true,force:true});}
