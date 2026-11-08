// Run reviewed tests unchanged against final applied source; redirect only harness metadata.
import {readFileSync as read,writeFileSync as write,cpSync,mkdtempSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../../..');
const review=resolve(process.env.CHAT_REVIEWED_PRIVACY_ROOT);
const stage=resolve(process.argv[2]);
const out=join(root,'docs/current-chat-mount/evidence/privacy');mkdirSync(out,{recursive:true});
const scratch=mkdtempSync('/tmp/mount-privacy-review-');
cpSync(join(review,'tests/track-b/chat-current-authority'),join(scratch,'tests/track-b/chat-current-authority'),{recursive:true});
cpSync(join(review,'docs/progress-chat-integration/server'),join(scratch,'docs/progress-chat-integration/server'),{recursive:true});
cpSync(join(review,'test/stubs'),join(scratch,'test/stubs'),{recursive:true});
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--require='+JSON.stringify(join(root,'tests/track-b/current-autonomy-integration/offline.cjs')),CHAT_REVIEW_DEPS:'/tmp/track-b-harness/node_modules'};
const summary={stage,tests:{},commands:[]};
for(const scope of ['authority','current-surfaces']){
 const path=join(scratch,'tests/track-b/chat-current-authority',scope,'run.mjs');
 let source=read(path,'utf8');
 source=source.replace("execFileSync('git',['rev-parse','--show-toplevel'],{cwd:here,encoding:'utf8'}).trim()",JSON.stringify(scratch));
 source=source.replace("execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()",JSON.stringify('reviewed exact patches in privacy-pin.json'));
 if(scope==='authority'){
  source=source.replace("for(const [find,file]", "alias.push({find:'@report-route',replacement:join(stage,'apps/web/src/app/api/jobs/[jobId]/autonomy/report/route.ts')},{find:'@/server/current-autonomy-runtime',replacement:join(scratch,'publication-runtime.ts')},{find:'@/server/current-autonomy',replacement:join(stage,'apps/web/src/server/current-autonomy.ts')});\nfor(const [find,file]");
  source=source.replace('SECURITY_STAGE:stage,','NODE_OPTIONS:process.env.NODE_OPTIONS,PUBLICATION_STAGE:stage,SECURITY_STAGE:stage,');
  source=source.replace('SECURITY_REPO:repo','SECURITY_REPO:'+JSON.stringify(review));
 }
 write(path,source);
 const test=read(join(scratch,'tests/track-b/chat-current-authority',scope,scope==='authority'?'authority.test.ts':'current.test.ts'));
 summary.tests[scope]=createHash('sha256').update(test).digest('hex');
 const r=spawnSync(process.execPath,[path,stage],{env,encoding:'utf8',maxBuffer:32*1024*1024});
 write(join(out,scope+'.log'),(r.stdout??'')+(r.stderr??''));summary.commands.push({scope,exit:r.status});console.log(scope,r.status);
}
write(join(out,'RESULTS.json'),JSON.stringify(summary,null,2)+'\n');if(summary.commands.some(c=>c.exit!==0))process.exitCode=1;
