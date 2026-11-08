import { execFileSync as exec } from 'node:child_process';
import { readFileSync as read, writeFileSync as write, mkdirSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {tmpdir} from 'node:os';
const here=dirname(fileURLToPath(import.meta.url)), root=resolve(here,'../..');
export const artifact='f88811c8fb7509dc5996bb8cd1d148e4c23f3de3';
export const integrated='28356f2e655a2559a5e5ca144439e71fc765370c';
export const parent='039851736eabb94e85c2c111bbccc78374716275';
const git=args=>exec('git',args,{cwd:root,maxBuffer:128*1024*1024});
const hash=b=>createHash('sha256').update(b).digest('hex');
const walk=(d,p='')=>existsSync(d)?readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name),p+e.name+'/'):[p+e.name]):[];
export async function stagePayment({out,baseline=false}={}) {
 let base;
 if(process.env.PAYMENT_PINNED_BASE){
  const pinned=resolve(process.env.PAYMENT_PINNED_BASE), inventory=JSON.parse(read(join(pinned,'CURRENT-COMPOSITION.json')));
  if(inventory.parent!==parent)throw Error('pinned_parent_mismatch');
  const stage=out?resolve(out):mkdtempSync(join(tmpdir(),'payment-startup-'));
  if(existsSync(stage)&&readdirSync(stage).length)throw Error('output_must_be_empty');
  mkdirSync(stage,{recursive:true});
  for(const [path,entry] of Object.entries({...inventory.preserved,...inventory.changes,...inventory.additions})){
   const bytes=read(join(pinned,path));if(hash(bytes)!==entry.sha256)throw Error('pinned_base_drift:'+path);
   mkdirSync(dirname(join(stage,path)),{recursive:true});write(join(stage,path),bytes);
  }
  for(const [path,expected] of Object.entries(JSON.parse(read(join(root,'docs/current-autonomy-integration/CANDIDATE.json'))).sourceHashes))
   if(hash(read(join(stage,path)))!==expected)throw Error('exact_candidate_source_drift:'+path);
  write(join(stage,'CURRENT-COMPOSITION.json'),JSON.stringify({...inventory,stage},null,2)+'\n');
  base={...inventory,stage};
 }else{
  const frozen=git(['ls-tree','-r','--name-only',artifact,'--','docs/current-autonomy-integration']).toString().trim().split('\n');
  for(const path of frozen){const exact=git(['show',`${artifact}:${path}`]);
   if(!exact.equals(read(join(root,path))))throw Error('exact_current_artifact_drift:'+path);
   if(!exact.equals(git(['show',`${integrated}:${path}`])))throw Error('integrated_artifact_drift:'+path);
  }
  const {stageCurrent}=await import('../current-autonomy-integration/stage.mjs');
  base=stageCurrent({out});
 }
 if(baseline)return base;
 const changes={}; const reviewChanges={};
 if(process.env.CHAT_REVIEW_COMPOSITION){
  const manifestPath=resolve(process.env.CHAT_REVIEW_COMPOSITION), manifest=JSON.parse(read(manifestPath));
  const reviewRoot=resolve(dirname(manifestPath),'../..');
  if(manifest.patches.length!==5 || manifest.patches[4].sha256!=='5b568a2b8a857b206ca8da088a95132d3135dc2257d8ee7b808c9ea0430ae109')throw Error('final_review_inventory_required');
  for(const item of manifest.patches){
   const bytes=read(join(reviewRoot,item.path));if(hash(bytes)!==item.sha256)throw Error('review_patch_hash_mismatch');
   const paths=[...bytes.toString().matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m=>m[1]);
   for(const path of paths)reviewChanges[path]??={preimage:existsSync(join(base.stage,path))?hash(read(join(base.stage,path))):null};
   exec('git',['apply','--check','-'],{cwd:base.stage,input:bytes});
   exec('git',['apply','-'],{cwd:base.stage,input:bytes});
   for(const path of paths)reviewChanges[path].sha256=hash(read(join(base.stage,path)));
  }
  for(const [path,expected] of Object.entries(manifest.finalSourceSha256??{}))
   if(hash(read(join(base.stage,path)))!==expected)throw Error('review_final_source_drift:'+path);
 }
 const additions={};
 for(const lane of ['bridge','startup'])for(const path of walk(join(here,lane,'source'))){
  const target=join(base.stage,path), bytes=read(join(here,lane,'source',path));
  // Only explicit patch postimages may replace the exact-current additive source.
  if(existsSync(target)){
   const before=read(target);if(before.equals(bytes))continue;
   changes[path]={preimage:hash(before),sha256:hash(bytes),bytes:bytes.length};
  }else additions[path]={sha256:hash(bytes),bytes:bytes.length};
  mkdirSync(dirname(target),{recursive:true});write(target,bytes);
 }
 for(const path of walk(join(here,'sql'))){
  const target=join(base.stage,'owner-payment-migrations',path),bytes=read(join(here,'sql',path));
  if(existsSync(target))throw Error('payment_sql_collision:'+path);
  mkdirSync(dirname(target),{recursive:true});write(target,bytes);
 }
 const result={artifact,integrated,parent,stage:base.stage,changes,additions,reviewChanges,releaseAccepted:false,liveRunPerformed:false};
 write(join(base.stage,'PAYMENT-COMPOSITION.json'),JSON.stringify(result,null,2)+'\n');
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const i=process.argv.indexOf('--out');console.log(JSON.stringify(await stagePayment({out:i<0?undefined:process.argv[i+1]})));
}
