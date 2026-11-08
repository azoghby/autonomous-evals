// Add the server child's immutable correction; do not repeat a known-blocked full build.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim();
const stage=resolve(process.argv[2]);const out=join(repo,'docs/chat-workflow-release/ui/evidence');
mkdirSync(out,{recursive:true});
const ref='a54ab05341856eb59a42f1e204a6cf89df19356b';
const patch=execFileSync('git',['show',ref+':docs/chat-workflow-release/servercompat/0001-current-core-server.patch'],{cwd:repo});
const file=join(stage,'.ui-inputs/servercompat.patch');writeFileSync(file,patch);
if(spawnSync('git',['apply','--reverse','--check',file],{cwd:stage}).status!==0){execFileSync('git',['apply','--check',file],{cwd:stage});execFileSync('git',['apply',file],{cwd:stage});}
const result={stage,serverCompatibility:ref,serverPatchSha256:createHash('sha256').update(patch).digest('hex'),fullBuildRepeated:false,priorFullBuildIncludedServerPatch:false,releaseAccepted:false,commands:[]};
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NEXT_TELEMETRY_DISABLED:'1',NEXT_FONT_GOOGLE_MOCKED_RESPONSES:join(stage,'offline-fonts.cjs'),NODE_OPTIONS:`--require=${join(stage,'offline.cjs')}`};
for(const [label,args] of [['final-typegen',['exec','-w','web','--','next','typegen']],['final-typecheck',['run','typecheck','-w','web']]]){
 const r=spawnSync('npm',args,{cwd:stage,env,encoding:'utf8',maxBuffer:16*1024*1024});writeFileSync(join(out,label+'.log'),(r.stdout??'')+(r.stderr??''));result.commands.push({command:['npm',...args],exit:r.status});console.log(label+': '+r.status);
}
const rendered=spawnSync(process.execPath,[join(here,'render.mjs'),stage],{cwd:repo,env,encoding:'utf8',maxBuffer:16*1024*1024});writeFileSync(join(out,'final-render.log'),(rendered.stdout??'')+(rendered.stderr??''));result.commands.push({command:['node',join(here,'render.mjs'),stage],exit:rendered.status});
writeFileSync(join(out,'final-summary.json'),JSON.stringify(result,null,2));console.log('final-render: '+rendered.status);
if(result.commands.some(c=>c.exit!==0))process.exitCode=1;
