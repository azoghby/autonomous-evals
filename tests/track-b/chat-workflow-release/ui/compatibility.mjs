// No install. Copy an already installed matching-lock cache into a disposable app.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,cpSync,readdirSync,constants,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {stageSeries} from './stage.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim();
const cache=resolve(process.env.CHAT_APP_CACHE??'/tmp/workflow-bootstrap.JpxCTM');
const output=resolve(process.env.CHAT_UI_OUTPUT??join(repo,'docs/chat-workflow-release/ui/evidence'));
mkdirSync(output,{recursive:true});
const input=process.env.CHAT_UI_STAGE?{...JSON.parse(readFileSync(join(output,'summary.json'))),stage:process.env.CHAT_UI_STAGE}:stageSeries();const {stage}=input;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
if(hash(join(stage,'package-lock.json'))!==hash(join(cache,'package-lock.json')))throw Error('Cache lockfile mismatch');
console.log('Copying locked installed cache to '+stage);
for(const p of ['node_modules','apps/web/node_modules'])if(!existsSync(join(stage,p)))cpSync(join(cache,p),join(stage,p),{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});
const summary={releaseAccepted:false,...input,cache,lockSha256:hash(join(stage,'package-lock.json')),commands:[],versions:{},unavailable:[]};
for(const name of ['next','react','react-dom','typescript','@neondatabase/serverless','workflow']){try{summary.versions[name]=JSON.parse(readFileSync(join(stage,'node_modules',name,'package.json'))).version;}catch{summary.unavailable.push(name);}}
if(summary.unavailable.length)throw Error('Unavailable installed dependencies: '+summary.unavailable.join(', '));
const correction=join(repo,'docs/chat-workflow-release/ui');
for(const f of ['restore-history.patch','next-esm-compatibility.patch']){if(spawnSync('git',['apply','--reverse','--check',join(correction,f)],{cwd:stage}).status===0)continue;execFileSync('git',['apply','--check',join(correction,f)],{cwd:stage});execFileSync('git',['apply',join(correction,f)],{cwd:stage});}
cpSync(join(stage,'apps/web/src/components/app/job-private-chat.tsx'),join(correction,'source/job-private-chat.tsx'));
// Use retained real font CSS and woff2 files; replace only Next's remote font fetch.
const fontCache=resolve(process.env.CHAT_FONT_CACHE??'/private/var/folders/dv/3krq9pqj29d7rz_qkckc6zqh0000gn/T/chat-real-current-uS8sgP/apps/web/.next');
const css=readdirSync(join(fontCache,'static/css')).filter(f=>f.endsWith('.css')).map(f=>readFileSync(join(fontCache,'static/css',f),'utf8')).join('\n');
const blocks=(css.match(/@font-face\{[^}]+\}/g)??[]).filter(b=>/font-family:Geist(?: Mono)?;/.test(b)).map(b=>b.replaceAll('/_next/static/media/',join(fontCache,'static/media')+'/'));
if(!blocks.length)throw Error('Unavailable cached Geist font faces');
writeFileSync(join(stage,'offline-fonts.cjs'),`module.exports=new Proxy({}, {get:(_,url)=>String(url).includes('Geist+Mono')?${JSON.stringify(blocks.filter(b=>b.includes('font-family:Geist Mono;')).join('\n'))}:${JSON.stringify(blocks.filter(b=>b.includes('font-family:Geist;')).join('\n'))}});`);
summary.fontBoundary='Next font fetch replaced with retained Geist CSS/woff2; no Google request; not a clean uncached build';
cpSync(join(here,'offline.cjs'),join(stage,'offline.cjs'));
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NEXT_TELEMETRY_DISABLED:'1',NEXT_FONT_GOOGLE_MOCKED_RESPONSES:join(stage,'offline-fonts.cjs'),NODE_OPTIONS:`--require=${join(stage,'offline.cjs')}`};
for(const [label,args] of [['typegen',['exec','-w','web','--','next','typegen']],['typecheck',['run','typecheck','-w','web']],['build',['run','build','-w','web']]]){
 console.log('Running '+label);const r=spawnSync('npm',args,{cwd:stage,env,encoding:'utf8',maxBuffer:32*1024*1024});writeFileSync(join(output,label+'.log'),(r.stdout??'')+(r.stderr??'')+(r.error?.stack??''));summary.commands.push({label,command:['npm',...args],exit:r.status});writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(label+': '+r.status);if(r.status!==0)process.exitCode=1;
}
console.log('Evidence '+output+'; retained '+stage);
