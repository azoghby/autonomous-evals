import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,readFileSync,readdirSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../../..'),stage=mkdtempSync(join(tmpdir(),'runtime-parameters-'));
const deps=process.env.RUNTIME_INSTALLED_MODULES??'/tmp/workflow-bootstrap.JpxCTM/node_modules';
const testsDeps=process.env.TRACK_B_NODE_MODULES??'/tmp/sandbox-generation-deps.cBCEai/node_modules';
const before=process.argv.includes('--before-fix');
try{
 const archive=execFileSync('git',['archive','875ceef','packages/core/src'],{cwd:root,maxBuffer:64*1024*1024});
 execFileSync('tar',['-xf','-','-C',stage],{input:archive});
 if(!before){const patch=readFileSync(join(root,'docs/track-b-runtime-parameter-fix/parameters.patch'));execFileSync('git',['apply','--check','-'],{cwd:stage,input:patch});execFileSync('git',['apply','-'],{cwd:stage,input:patch});}
 mkdirSync(join(stage,'tests'));copyFileSync(join(root,'tests/track-b/runtime-parameter-fix/parameters.test.ts'),join(stage,'tests/parameters.test.ts'));
 mkdirSync(join(stage,'node_modules'));
 for(const name of readdirSync(deps))symlinkSync(join(deps,name),join(stage,'node_modules',name));
 for(const name of ['@electric-sql','vitest','typescript'])if(!existsSync(join(stage,'node_modules',name)))symlinkSync(join(testsDeps,name),join(stage,'node_modules',name));
 writeFileSync(join(stage,'package.json'),'{"type":"module"}');
 writeFileSync(join(stage,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']},include:['tests/*.ts']}));
 execFileSync(process.execPath,[join(stage,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],{cwd:stage,stdio:'inherit'});
 execFileSync(process.execPath,[join(stage,'node_modules/vitest/vitest.mjs'),'run','tests/parameters.test.ts','--maxWorkers=1','--reporter=default'],{cwd:stage,stdio:'inherit'});
 console.log(JSON.stringify({beforeFix:before,contractRef:'875ceef',strict:true,network:false}));
}finally{rmSync(stage,{recursive:true,force:true});}
