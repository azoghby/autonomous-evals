// Offline, exact preimage composition. Never modifies the supplied owner candidate.
import {cpSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
if(!process.argv[2])throw Error('Usage: node compose.mjs EXACT_CANDIDATE [OUTPUT_JSON]');
const candidate=resolve(process.argv[2]),stage=mkdtempSync('/tmp/chat-reviewed-composition-');
cpSync(candidate,stage,{recursive:true,verbatimSymlinks:true,filter:p=>!['node_modules','.next','.git'].includes(basename(p))});
const paths=['authority/0001-refresh-authority-policy.patch','privacy/use-live-job-isolation.patch','current-surfaces/recheck-artifact-authority.patch','current-surfaces/0002-existing-owner-fixture.patch','authority/0002-reauthorize-publication.patch'];
const patches=[];
for(const p of paths){const path=join(root,'docs/chat-current-authority',p),bytes=readFileSync(path);execFileSync('git',['apply','--check','-'],{cwd:stage,input:bytes});execFileSync('git',['apply','-'],{cwd:stage,input:bytes});patches.push({path:'docs/chat-current-authority/'+p,sha256:createHash('sha256').update(bytes).digest('hex')})}
const result={candidate,stage,patches,clientCorrection:'None: exact candidate client passed 16 interaction/privacy cases unchanged; do not restore historical client source',releaseAccepted:false,scope:'Clean patch composition only. Rerun authority/privacy/current-surface tests and final mount tests on this composition.'};
if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
