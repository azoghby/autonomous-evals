import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,cpSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim();
let stage=process.argv[2];
if(!stage){const out=execFileSync(process.execPath,[join(here,'stage.mjs')],{cwd:repo,encoding:'utf8'});console.log(out);stage=JSON.parse(out).stage;}
const deps=resolve(process.env.CHAT_UI_NODE_MODULES??'/tmp/progress-chat-ui-verification/node_modules');
const suite=mkdtempSync(join(tmpdir(),'chat-release-ui-'));
cpSync(here,suite,{recursive:true});
cpSync(join(stage,'apps/web/src/components/app/job-private-chat.tsx'),join(suite,'job-private-chat.tsx'));
cpSync(join(here,'reauth.test.tsx'),join(suite,'reauth.test.tsx'));
symlinkSync(deps,join(suite,'node_modules'),'dir');
writeFileSync(join(suite,'package.json'),'{"private":true,"type":"module"}');
writeFileSync(join(suite,'vitest.config.ts'),`export default {test:{environment:'jsdom',include:['*.test.tsx']}};`);
function run(name,tool,args){const r=spawnSync(join(deps,'.bin',tool),args,{cwd:suite,encoding:'utf8'});writeFileSync(join(suite,name+'.log'),(r.stdout??'')+(r.stderr??''));console.log(name+': exit '+r.status);return r;}
const baseline=run('uncorrected-regression','vitest',['run','--config','vitest.config.ts','reauth.test.tsx']);
if(baseline.status===0 || !/4 failed/.test(baseline.stdout??''))throw Error('Expected four original regression failures; inspect '+suite);
const component=join(suite,'job-private-chat.tsx');
const original=readFileSync(component,'utf8');
// Apply the actual reviewable artifact to an isolated app-shaped path.
const patchRoot=join(suite,'patched');
execFileSync('mkdir',['-p',join(patchRoot,'apps/web/src/components/app')]);
cpSync(component,join(patchRoot,'apps/web/src/components/app/job-private-chat.tsx'));
execFileSync('git',['apply','--check',join(repo,'docs/chat-workflow-release/ui/restore-history.patch')],{cwd:patchRoot});
execFileSync('git',['apply',join(repo,'docs/chat-workflow-release/ui/restore-history.patch')],{cwd:patchRoot});
cpSync(join(patchRoot,'apps/web/src/components/app/job-private-chat.tsx'),component);
if(run('corrected-typecheck','tsc',['--noEmit','-p','tsconfig.json']).status!==0)throw Error('Corrected UI typecheck failed: '+suite);
const result=run('corrected-tests','vitest',['run','--config','vitest.config.ts']);
const evidence=join(repo,'docs/chat-workflow-release/ui/evidence/interactions');execFileSync('mkdir',['-p',evidence]);for(const name of ['uncorrected-regression','corrected-typecheck','corrected-tests'])cpSync(join(suite,name+'.log'),join(evidence,name+'.log'));
console.log(result.stdout);console.log('React '+JSON.parse(readFileSync(join(deps,'react/package.json'))).version+' jsdom fixture only. Evidence '+suite);
if(result.status!==0)throw Error('Corrected UI tests failed: '+suite);
