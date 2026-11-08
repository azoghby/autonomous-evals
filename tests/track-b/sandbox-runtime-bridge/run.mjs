import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,cpSync,readFileSync,readdirSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../../..'),stage=mkdtempSync(join(tmpdir(),'sandbox-runtime-bridge-'));
const deps=process.env.RUNTIME_INSTALLED_MODULES??'/tmp/workflow-bootstrap.JpxCTM/node_modules';
const testDeps=process.env.TRACK_B_NODE_MODULES??'/tmp/sandbox-generation-deps.cBCEai/node_modules';
const ref='875ceef6a743df41736ee55c4145ca794e0854a8';
try {
 const archive=execFileSync('git',['archive',ref,'packages/core/src'],{cwd:root,maxBuffer:64*1024*1024});
 execFileSync('tar',['-xf','-','-C',stage],{input:archive});
 // The existing artifact is necessary for bound-value compatibility acceptance.
 const patch=readFileSync(join(root,'docs/track-b-runtime-parameter-fix/parameters.patch'));
 execFileSync('git',['apply','--check','-'],{cwd:stage,input:patch});
 execFileSync('git',['apply','-'],{cwd:stage,input:patch});
 for(const path of ['packages/core/src/evals/sandbox/runtime-bridge','packages/core/src/evals/sandbox/grading','tests/track-b/sandbox-runtime-bridge']){
  mkdirSync(join(stage,path),{recursive:true});cpSync(join(root,path),join(stage,path),{recursive:true});
 }
 mkdirSync(join(stage,'node_modules'));
 for(const name of readdirSync(deps))symlinkSync(join(deps,name),join(stage,'node_modules',name));
 for(const name of ['@electric-sql','vitest','typescript'])if(!existsSync(join(stage,'node_modules',name)))symlinkSync(join(testDeps,name),join(stage,'node_modules',name));
 writeFileSync(join(stage,'package.json'),'{"type":"module"}');
 writeFileSync(join(stage,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']},include:['tests/track-b/sandbox-runtime-bridge/*.test.ts','packages/core/src/evals/sandbox/runtime-bridge/**/*.ts']}));
 execFileSync(process.execPath,[join(stage,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],{cwd:stage,stdio:'inherit'});
 execFileSync(process.execPath,[join(stage,'node_modules/vitest/vitest.mjs'),'run','tests/track-b/sandbox-runtime-bridge','--maxWorkers=1','--reporter=default'],{cwd:stage,stdio:'inherit'});
 console.log(JSON.stringify({runtimeRef:ref,parameterPatch:'staging-only; Track A adoption required',strict:true,network:false}));
}finally{rmSync(stage,{recursive:true,force:true});}
