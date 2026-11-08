// Run full app checks while independent SQL suites execute, using the same source stage.
import {readFileSync as read,writeFileSync as write,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../../..'),stage=resolve(process.argv[2]);
const out=join(root,'docs/current-chat-mount/evidence/app');mkdirSync(out,{recursive:true});
const deps='/tmp/workflow-bootstrap.JpxCTM/node_modules';
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NEXT_TELEMETRY_DISABLED:'1',npm_config_offline:'true',NODE_OPTIONS:'--require='+JSON.stringify(join(root,'tests/track-b/current-autonomy-integration/offline.cjs'))};
const fonts='/private/var/folders/dv/3krq9pqj29d7rz_qkckc6zqh0000gn/T/chat-real-current-uS8sgP/apps/web/.next';
const css=readdirSync(join(fonts,'static/css')).filter(n=>n.endsWith('.css')).map(n=>read(join(fonts,'static/css',n),'utf8')).join('\n');
const blocks=(css.match(/@font-face\{[^}]+\}/g)??[]).filter(b=>/font-family:Geist(?: Mono)?;/.test(b)).map(b=>b.replaceAll('/_next/static/media/',join(fonts,'static/media')+'/'));
if(!blocks.length)throw Error('Retained local font cache unavailable; no network fallback');
write(join(stage,'offline-fonts.cjs'),`module.exports=new Proxy({}, {get:(_,url)=>String(url).includes('Geist+Mono')?${JSON.stringify(blocks.filter(b=>b.includes('font-family:Geist Mono;')).join('\n'))}:${JSON.stringify(blocks.filter(b=>b.includes('font-family:Geist;')).join('\n'))}});`);
env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES=join(stage,'offline-fonts.cjs');
const commands=[];
for(const [label,exe,args,cwd]of [
 ['typegen',process.execPath,[join(deps,'next/dist/bin/next'),'typegen'],join(stage,'apps/web')],
 ['typecheck','npx',['--offline','tsc','-p','apps/web','--noEmit'],stage],
 ['build',process.execPath,[join(deps,'next/dist/bin/next'),'build','--webpack'],join(stage,'apps/web')],
]){
 console.log('Running '+label);const r=spawnSync(exe,args,{cwd,env,encoding:'utf8',maxBuffer:64*1024*1024});
 write(join(out,label+'.log'),(r.stdout??'')+(r.stderr??'')+(r.error?.stack??''));commands.push({label,command:[exe,...args],exit:r.status});write(join(out,'RESULTS.json'),JSON.stringify({stage,commands,fontBoundary:'Retained local real font cache; no uncached installation or network'},null,2)+'\n');console.log(label,r.status);
}
if(commands.some(c=>c.exit!==0))process.exitCode=1;
