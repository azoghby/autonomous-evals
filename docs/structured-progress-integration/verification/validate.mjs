import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim();
const base='2dff9d8af8cccdd171d78760a0d74136d138fcb4';
const core='e47a852737e7aca7d2fa984c363abe58f5c0ad05';
const stage=mkdtempSync(join(tmpdir(),'structured-progress-'));
function archive(ref,paths=[]){const data=execFileSync('git',['archive',ref,...paths],{cwd:repo,maxBuffer:128*1024*1024});execFileSync('tar',['-x','-C',stage],{input:data});}
function apply(file){execFileSync('git',['apply','--check',file],{cwd:stage});execFileSync('git',['apply',file],{cwd:stage});}
archive(base);
// The earlier chat deliverable remains a prerequisite on this newer Track A pin.
apply(join(repo,'docs/progress-chat-integration/combined.patch'));
// Explicit immutable Track B source prerequisite. Extraction overlays core sources;
// Track A-only contracts/composition stay present. This is a test composition, not
// a production merge artifact, and does NOT include the parent's pending fixes.
archive(core,['packages/core/src']);
const patch=resolve(process.argv.slice(2).find(a=>!a.startsWith('--'))??join(here,'../backend/structured-progress.patch'));
if(!existsSync(patch))throw new Error(`Required reviewed backend patch missing: ${patch}`);
apply(patch);
console.log(`Track A ${base}\nCore prerequisite ${core}\nApplied prior combined.patch then core prerequisite then ${patch}\nStaging ${stage}`);
if(process.argv.includes('--stage-only'))process.exit(0);
const deps=resolve(process.env.STRUCTURED_NODE_MODULES??'/tmp/track-b-harness/node_modules');
symlinkSync(deps,join(stage,'node_modules'),'dir');
writeFileSync(join(stage,'package.json'),'{"private":true,"type":"module"}');
mkdirSync(join(stage,'structured-verification'),{recursive:true});
copyFileSync(join(here,'../backend/001-structured-progress.sql'),join(stage,'structured-verification/inventory.sql'));
for(const file of ['structured.test.ts','dispatcher.test.ts','fixture-pool.ts','fixture-session.ts','empty.ts'])copyFileSync(join(here,file),join(stage,'structured-verification',file));
const config={resolve:{alias:[
{find:'@structured',replacement:join(stage,'apps/web/src/server/structured-progress.ts')},
{find:/^@ae\/core\/(.*)$/,replacement:join(stage,'packages/core/src/$1')},
{find:'server-only',replacement:join(stage,'structured-verification/empty.ts')}
]},test:{include:['structured-verification/*.test.ts','packages/core/src/reporting/chat/projection/*.test.ts','packages/core/src/reporting/chat/service.test.ts'],maxWorkers:1,minWorkers:1,testTimeout:30000}};
// RegExp cannot survive JSON serialization.
writeFileSync(join(stage,'vitest.structured.config.mjs'),`export default {resolve:{alias:[{find:'@writer',replacement:${JSON.stringify(join(stage,'apps/web/src/server/structured-progress-inventory.ts'))}},{find:'@dispatcher',replacement:${JSON.stringify(join(stage,'apps/web/src/server/progress-chat.ts'))}},{find:'./session',replacement:${JSON.stringify(join(stage,'structured-verification/fixture-session.ts'))}},{find:'@neondatabase/serverless',replacement:${JSON.stringify(join(stage,'structured-verification/fixture-pool.ts'))}},{find:'@structured',replacement:${JSON.stringify(join(stage,'apps/web/src/server/structured-progress.ts'))}},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}},{find:'server-only',replacement:${JSON.stringify(join(stage,'structured-verification/empty.ts'))}}]},test:${JSON.stringify(config.test)}};`);
execFileSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--config',join(stage,'vitest.structured.config.mjs'),'--reporter=default','--reporter=json',`--outputFile.json=${join(stage,'structured-results.json')}`],{cwd:stage,stdio:'inherit',env:{...process.env,STRUCTURED_STAGE:stage}});
const result=JSON.parse(readFileSync(join(stage,'structured-results.json'),'utf8'));
const cases=result.testResults.flatMap(f=>f.assertionResults);
if(!cases.length||cases.some(c=>c.status!=='passed'))throw new Error('Missing, failing, or skipped selected tests');
console.log(`${cases.length} selected tests passed, none skipped. Local SQL/fixture boundaries only; no deployed or rendered acceptance. Stage retained.`);
