import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
const repo=process.cwd(),here=resolve('docs/naive-operator-adoption-integration'),stage='/tmp/naive-operator-combined-stage';
const manifest=JSON.parse(readFileSync(here+'/manifest.json'));const applied=mkdtempSync('/tmp/operator-patch-apply-');
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const f of manifest.files){if(f.beforeSha256){const b=spawnSync('git',['show',manifest.baseCommit+':'+f.path],{cwd:repo}).stdout;const p=applied+'/'+f.path;mkdirSync(dirname(p),{recursive:true});writeFileSync(p,b);}}
let p=spawnSync('git',['apply','--unsafe-paths',here+'/owner.patch'],{cwd:applied,encoding:'utf8'});if(p.status)throw Error(p.stderr);
for(const f of manifest.files)if(sha(readFileSync(applied+'/'+f.path))!==f.afterSha256)throw Error(f.path);
writeFileSync(here+'/evidence/applied-patch.json',JSON.stringify({baseCommit:manifest.baseCommit,temporaryPreimageStage:applied,postimagesVerified:10},null,2)+'\n');
const review=resolve('docs/expert-review-surface-integration/tests'),recovery=resolve('docs/naive-proxy-recovery-integration/tests/recovery.test.ts');
mkdirSync(stage+'/combined-tests',{recursive:true});copyFileSync(recovery,stage+'/combined-tests/recovery.test.ts');
const config={oxc:{jsx:{runtime:'automatic'}},resolve:{alias:{'@neondatabase/serverless':stage+'/node_modules/@neondatabase/serverless/index.mjs',next:stage+'/node_modules/next','react-dom':stage+'/node_modules/react-dom',react:stage+'/node_modules/react','@electric-sql/pglite':stage+'/node_modules/@electric-sql/pglite','@review-routes':stage+'/apps/web/src/app/api/operator/expert-reviews','@ae/core':stage+'/packages/core/src','@':stage+'/apps/web/src','server-only':stage+'/test/stubs/server-only.ts'}},test:{include:[review+'/*.test.ts',stage+'/combined-tests/recovery.test.ts'],maxWorkers:1,testTimeout:60000,hookTimeout:60000}};
writeFileSync(stage+'/combined.vitest.config.mjs','export default '+JSON.stringify(config));
const commands=[['tests',process.execPath,[stage+'/node_modules/vitest/vitest.mjs','run','--config',stage+'/combined.vitest.config.mjs','--reporter=default','--reporter=json','--outputFile='+here+'/evidence/tests.json'],repo],['typegen',process.execPath,[stage+'/node_modules/next/dist/bin/next','typegen'],stage+'/apps/web'],['web-typecheck',process.execPath,[stage+'/node_modules/typescript/bin/tsc','-p','apps/web','--noEmit'],stage],['core-typecheck',process.execPath,[stage+'/node_modules/typescript/bin/tsc','-p','packages/core','--noEmit'],stage]];
const results=[];for(const [name,cmd,args,cwd] of commands){const r=spawnSync(cmd,args,{cwd,encoding:'utf8',timeout:240000,maxBuffer:20e6});writeFileSync(here+'/evidence/'+name+'.log',r.stdout+r.stderr);results.push({name,status:r.status,error:r.error?.message});console.log(name,r.status);}
writeFileSync(here+'/evidence/commands.json',JSON.stringify(results,null,2)+'\n');
