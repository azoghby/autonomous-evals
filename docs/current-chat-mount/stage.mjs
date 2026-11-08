// Composes the exact current candidate, reviewed privacy fixes, then the owner mount.
import {execFileSync as exec} from 'node:child_process';
import {readFileSync as read,writeFileSync as write,cpSync,mkdtempSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageCurrent,root,sha} from '../current-autonomy-integration/stage.mjs';
import {applyMount} from './integration/apply.mjs';
export function stageMount({out,privacyCommit=process.env.CHAT_PRIVACY_COMMIT}={}) {
 if(!privacyCommit&&!process.env.CHAT_REVIEWED_PRIVACY_ROOT)throw Error('CHAT_PRIVACY_COMMIT must name the reviewed privacy commit; unsafe baseline mounting is refused');
 const pin=JSON.parse(read(new URL('./privacy-pin.json',import.meta.url)));
 let result;
 if(process.env.CHAT_EXACT_CANDIDATE){
  const candidate=resolve(process.env.CHAT_EXACT_CANDIDATE);
  result=JSON.parse(read(join(candidate,'CURRENT-COMPOSITION.json')));
  const candidatePin=JSON.parse(read(new URL('../current-autonomy-integration/CANDIDATE.json',import.meta.url)));
  for(const [path,hash]of Object.entries(candidatePin.sourceHashes))if(sha(read(join(candidate,path)))!==hash)throw Error('Pinned candidate source drift: '+path);
  if(result.parent!=='039851736eabb94e85c2c111bbccc78374716275'||result.baseline)throw Error('Wrong candidate parent');
  for(const entries of [result.preserved,result.changes,result.additions])for(const [path,record]of Object.entries(entries))if(sha(read(join(candidate,path)))!==record.sha256)throw Error('Candidate drift: '+path);
  if(out&&existsSync(resolve(out))&&readdirSync(resolve(out)).length)throw Error('Output must be empty');
  result.stage=out?resolve(out):mkdtempSync(join(tmpdir(),'current-chat-mount-'));
  cpSync(candidate,result.stage,{recursive:true,verbatimSymlinks:true,filter:p=>!['node_modules','.next','.git'].includes(p.split('/').at(-1))});
 }else result=stageCurrent({out});
 const applied=[];
 for(const record of pin.patches){
  const bytes=process.env.CHAT_REVIEWED_PRIVACY_ROOT?read(join(resolve(process.env.CHAT_REVIEWED_PRIVACY_ROOT),record.path)):exec('git',['show',`${privacyCommit}:${record.path}`],{cwd:root});
  if(sha(bytes)!==record.sha256)throw Error('Reviewed patch hash mismatch: '+record.path);
  exec('git',['apply','--check','-'],{cwd:result.stage,input:bytes});
  exec('git',['apply','-'],{cwd:result.stage,input:bytes});
  applied.push(record);
 }
 const mount=applyMount(result.stage);
 // Preserve a complete original candidate inventory alongside final applied hashes.
 write(join(result.stage,'PRE-MOUNT-COMPOSITION.json'),JSON.stringify(result,null,2)+'\n');
 for(const [kind,entries] of Object.entries({preserved:result.preserved,changes:result.changes,additions:result.additions}))for(const [path,entry]of Object.entries(entries)){
  const bytes=read(join(result.stage,path));const hash=sha(bytes);
  if(entry.sha256!==hash){
   const correction={preimage:entry,sha256:hash,bytes:bytes.length,reason:'Reviewed privacy composition or owner mount'};
   if(kind==='preserved'){delete entries[path];result.changes[path]=correction;}
   else entries[path]=correction;
  }
 }
 result.preservedFiles=Object.keys(result.preserved).length;
 result.preservedBytes=Object.values(result.preserved).reduce((n,e)=>n+e.bytes,0);
 result.chatMount={privacyCommit:privacyCommit??null,reviewedPatchHashes:true,patches:applied,mount,clientCorrection:pin.clientCorrection};
 write(join(result.stage,'CURRENT-COMPOSITION.json'),JSON.stringify(result,null,2)+'\n');
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const i=process.argv.indexOf('--out');const r=stageMount({out:i<0?undefined:process.argv[i+1]});
 console.log(JSON.stringify({stage:r.stage,parent:r.parent,chatMount:r.chatMount,preservedFiles:r.preservedFiles}));
}
