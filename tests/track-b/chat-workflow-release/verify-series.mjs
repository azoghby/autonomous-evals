// Source integrity and actual clean application checks; no installs or runtime services.
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {stageRelease,root} from './stage.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const restore=JSON.parse(readFileSync(join(root,'docs/chat-workflow-release/RESTORE.json'),'utf8'));
for(const file of restore.files){
 const bytes=readFileSync(join(root,file.restored));
 assert.equal(digest(bytes),file.sha256);
 assert.deepEqual(bytes,execFileSync('git',['show',`${restore.commit}:${file.source}`],{cwd:root,maxBuffer:8*1024*1024}));
}
const result=stageRelease();
const preserved={};
for(const file of ['package.json','package-lock.json','packages/core/package.json']) {
 const original=execFileSync('git',['show',`${result.trackA}:${file}`],{cwd:root});
 assert.deepEqual(readFileSync(join(result.stage,file)),original,`Pinned ${file} must remain intact`);
 preserved[file]=digest(original);
}
const report={...result,restoredFilesVerified:restore.files.length,preservedManifestAndLockSha256:preserved,checks:'Byte-for-byte restoration, digest-guarded git apply --check/apply, preserved pinned manifests/locks',boundary:'Source application only; UI/build and mocked server checks have separate evidence. No SQL, service, auth or provider acceptance.'};
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
