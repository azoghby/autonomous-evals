import {spawnSync} from 'node:child_process';
import {readFileSync as read,writeFileSync as write,mkdirSync,readdirSync,symlinkSync,existsSync,cpSync,mkdtempSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..');
const out=resolve(process.env.CALENDAR_EVIDENCE??join(here,'evidence'));mkdirSync(out,{recursive:true});
const stage=resolve(process.env.CALENDAR_STAGE??mkdtempSync(join(tmpdir(),'current-calendar-check-')));
const installed=resolve(process.env.WORKFLOW_INSTALLED_WORKSPACE??'/tmp/workflow-bootstrap.JpxCTM'),deps=join(installed,'node_modules');
const cache=resolve(process.env.AUTONOMY_NODE_MODULES??'/tmp/sandbox-generation-deps.cBCEai/node_modules');
const summary={stage,node:process.version,candidate:'f88811c8fb7509dc5996bb8cd1d148e4c23f3de3',commands:[],releaseAccepted:false,liveRunPerformed:false,limits:['Scripted target transport; no provider billing or hosted Workflow proof.','PGlite real table SQL, single backend; advisory-lock calls shimmed, no PostgreSQL multi-session proof.','Offline retained dependency caches; no clean install proof.']};
const persist=()=>write(join(out,'RESULTS.json'),JSON.stringify(summary,null,2)+'\n');
const env={CALENDAR_RETAINED_STAGE:process.env.CALENDAR_RETAINED_STAGE,CALENDAR_ARCHIVE_GIT_DIR:process.env.CALENDAR_ARCHIVE_GIT_DIR,PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NEXT_TELEMETRY_DISABLED:'1',npm_config_offline:'true',WORKFLOW_STAGE:stage,EXTENSION_STAGE:stage};
function run(label,args,cwd=stage,executable=process.execPath){console.log('Running '+label);const r=spawnSync(executable,args,{cwd,env,encoding:'utf8',maxBuffer:96*1024*1024});write(join(out,label+'.log'),(r.stdout??'')+(r.stderr??'')+(r.error?.stack??''));summary.commands.push({label,command:[executable,...args],exit:r.status});persist();console.log(label+': '+r.status);return r.status===0;}
if(!process.env.CALENDAR_STAGE&&!run('stage',[join(root,'docs/current-autonomy-calendar/stage.mjs'),'--out',stage],root))process.exit(1);
for(const tree of [deps,cache]){if(!existsSync(tree))throw Error('Missing offline cache '+tree);mkdirSync(join(stage,'node_modules'),{recursive:true});for(const entry of readdirSync(tree)){if(entry==='@ae')continue;if(entry.startsWith('@')){mkdirSync(join(stage,'node_modules',entry),{recursive:true});for(const n of readdirSync(join(tree,entry)))if(!existsSync(join(stage,'node_modules',entry,n)))symlinkSync(join(tree,entry,n),join(stage,'node_modules',entry,n));}else if(!existsSync(join(stage,'node_modules',entry)))symlinkSync(join(tree,entry),join(stage,'node_modules',entry));}}
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});if(!existsSync(join(stage,'node_modules/@ae/core')))symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'));
for(const sub of ['apps/web','packages/core'])if(existsSync(join(installed,sub,'node_modules'))&&!existsSync(join(stage,sub,'node_modules')))symlinkSync(join(installed,sub,'node_modules'),join(stage,sub,'node_modules'));
cpSync(here,join(stage,'tests/track-b/current-autonomy-calendar'),{recursive:true,filter:p=>!p.includes('/evidence')});
// Migration is an unchanged candidate dependency, copied for explicit test fixture setup only.
const inventory='docs/current-autonomy-integration/dependencies/owner-migrations/app.inventory.sql';mkdirSync(dirname(join(stage,inventory)),{recursive:true});cpSync(join(root,inventory),join(stage,inventory));
write(join(stage,'empty-server-only.mjs'),'export {};\n');
write(join(stage,'calendar-vitest.config.mjs'),`export default {resolve:{alias:{'@ae/core':${JSON.stringify(join(stage,'packages/core/src'))},'@':${JSON.stringify(join(stage,'apps/web/src'))},'server-only':${JSON.stringify(join(stage,'empty-server-only.mjs'))}}},test:{include:['tests/track-b/current-autonomy-calendar/**/*.test.ts','packages/core/src/evals/calendar-integration/**/*.test.ts'],maxWorkers:1,testTimeout:30000,hookTimeout:30000}};`);
write(join(stage,'tsconfig.calendar-tests.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*'],'@/*':['./apps/web/src/*']}},include:['tests/track-b/current-autonomy-calendar/**/*.ts']}));
const guard=join(stage,'offline-calendar.cjs');cpSync(join(root,'tests/track-b/current-autonomy-integration/offline.cjs'),guard);env.NODE_OPTIONS='--require='+JSON.stringify(guard);
run('test-typecheck',[join(deps,'typescript/bin/tsc'),'-p','tsconfig.calendar-tests.json']);
run('calendar-runtime-tests',[join(deps,'vitest/vitest.mjs'),'run','--config','calendar-vitest.config.mjs','--reporter=json','--outputFile.json='+join(out,'tests.json')]);
run('parent-npm-test',['test','--','--maxWorkers=2','--reporter=json','--outputFile.json='+join(out,'parent-tests.json')],stage,'npm');
write(join(stage,'packages/core/tsconfig.calendar.json'),JSON.stringify({extends:'./tsconfig.json',compilerOptions:{strict:true,noEmit:true},exclude:['node_modules','**/*.test.ts','**/*.test.tsx','**/*.spec.ts']}));
run('core-typecheck',[join(deps,'typescript/bin/tsc'),'-p','tsconfig.calendar.json'],join(stage,'packages/core'));
run('next-typegen',[join(deps,'next/dist/bin/next'),'typegen'],join(stage,'apps/web'));
run('app-typecheck',[join(deps,'typescript/bin/tsc'),'-p','apps/web','--noEmit']);
if(!process.argv.includes('--tests-only')){
 const fonts=resolve(process.env.CHAT_FONT_CACHE??'/private/var/folders/dv/3krq9pqj29d7rz_qkckc6zqh0000gn/T/chat-real-current-uS8sgP/apps/web/.next');
 if(existsSync(join(fonts,'static/css'))){const css=readdirSync(join(fonts,'static/css')).filter(n=>n.endsWith('.css')).map(n=>read(join(fonts,'static/css',n),'utf8')).join('\n');const blocks=(css.match(/@font-face\{[^}]+\}/g)??[]).filter(b=>/font-family:Geist(?: Mono)?;/.test(b)).map(b=>b.replaceAll('/_next/static/media/',join(fonts,'static/media')+'/'));if(!blocks.length)throw Error('No retained Geist fonts');write(join(stage,'offline-fonts.cjs'),`module.exports=new Proxy({}, {get:(_,url)=>String(url).includes('Geist+Mono')?${JSON.stringify(blocks.filter(b=>b.includes('font-family:Geist Mono;')).join('\n'))}:${JSON.stringify(blocks.filter(b=>b.includes('font-family:Geist;')).join('\n'))}});`);env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES=join(stage,'offline-fonts.cjs');run('next-workflow-build',[join(deps,'next/dist/bin/next'),'build','--webpack'],join(stage,'apps/web'));}else summary.commands.push({label:'next-workflow-build',exit:null,blocked:'Missing retained font cache, no network fallback.'});
}
for(const [file,key] of [['tests.json','tests'],['parent-tests.json','parentTests']])if(existsSync(join(out,file))){const t=JSON.parse(read(join(out,file)));summary[key]={passed:t.numPassedTests,failed:t.numFailedTests,skipped:t.numPendingTests};if(!t.numPassedTests||t.numFailedTests||t.numFailedTestSuites)summary.commands.push({label:key+'-completeness',exit:1});}
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(read(join(root,'docs/current-autonomy-calendar/APPLICATION.json')));
const composition=JSON.parse(read(join(stage,'CURRENT-COMPOSITION.json')));
const drift=[];
for(const [p,v] of Object.entries({...composition.preserved,...composition.changes,...composition.additions})){
 const expected=manifest.changes[p]?.sha256??v.sha256;
 if(!existsSync(join(stage,p))||sha(read(join(stage,p)))!==expected)drift.push(p);
}
for(const [p,v] of Object.entries(manifest.changes))if(sha(read(join(root,'docs/current-autonomy-calendar/source',p)))!==v.sha256)drift.push('artifact:'+p);
summary.finalSourceIntegrity={patchSha256:sha(read(join(root,'docs/current-autonomy-calendar/calendar.patch'))),changedFiles:Object.keys(manifest.changes).length,drift};if(drift.length)summary.commands.push({label:'final-applied-source-integrity',exit:1});
persist();if(summary.commands.some(c=>c.exit!==0))process.exitCode=1;
