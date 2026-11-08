import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,symlinkSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),deps=join(root,'tests/track-b/node_modules');
const ref='aa94505fd535f5c0f586cc6325b49b71a1683761';
const stage=mkdtempSync(join(tmpdir(),'sandbox-identity-'));
try {
 mkdirSync(join(stage,'src/evals/sandbox'),{recursive:true});mkdirSync(join(stage,'src/sandbox'));
 writeFileSync(join(stage,'src/sandbox/spec.ts'),execFileSync('git',['show',`${ref}:packages/core/src/sandbox/spec.ts`],{cwd:root}));
 copyFileSync(join(root,'packages/core/src/evals/sandbox/identity.ts'),join(stage,'src/evals/sandbox/identity.ts'));
 copyFileSync(join(root,'tests/track-b/sandbox-identity/identity.test.ts'),join(stage,'src/evals/sandbox/identity.test.ts'));
 symlinkSync(deps,join(stage,'node_modules'));
 writeFileSync(join(stage,'package.json'),JSON.stringify({type:'module'}));
 writeFileSync(join(stage,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node']},include:['src/**/*.ts']}));
 execFileSync(process.execPath,[join(deps,'typescript/bin/tsc'),'-p','tsconfig.json'],{cwd:stage,stdio:'inherit'});
 execFileSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile=result.json'],{cwd:stage,stdio:'inherit'});
 const result=JSON.parse(readFileSync(join(stage,'result.json')));
 if(result.numPassedTests!==12||result.numFailedTests||result.numPendingTests)throw Error('Incomplete identity tests');
 console.log(JSON.stringify({contractRef:ref,passed:result.numPassedTests,strict:true,network:false}));
} finally {rmSync(stage,{recursive:true,force:true});}
