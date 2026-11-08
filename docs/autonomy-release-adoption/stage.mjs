import {execFileSync as exec} from 'node:child_process';
import {readFileSync as read,writeFileSync as write,mkdirSync,mkdtempSync,existsSync,readdirSync,cpSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {stageJudged,root,pins as judgedPins} from '../track-b-judged-release/stage.mjs';
export {root};
export const pins=Object.freeze({judgedTrackA:judgedPins.trackA,ownerTrackA:'875ceef6a743df41736ee55c4145ca794e0854a8',core:'e4686a84f248bfe8be9bcda4ed534b0807379714'});
const here=dirname(fileURLToPath(import.meta.url));
export const sha=b=>createHash('sha256').update(b).digest('hex');
const git=(args,extra={})=>exec('git',args,{cwd:root,maxBuffer:128*1024*1024,stdio:['pipe','pipe','pipe'],...extra});
function blob(ref,p){try{return git(['show',ref+':'+p]);}catch{return null;}}
const put=(stage,p,b)=>{mkdirSync(dirname(join(stage,p)),{recursive:true});write(join(stage,p),b);};
function walk(dir,p=''){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name),p+e.name+'/'):[p+e.name]);}
export function stageAutonomy({includeAdoption=true,includeCore=true}={}){
 const historical=stageJudged(),{stage}=historical;
 const refreshed=[];
 // Apply A's own delta AFTER historical composition using exact three-way preimages.
 for(const p of git(['diff','--name-only',pins.judgedTrackA,pins.ownerTrackA,'--','apps','packages','package.json','package-lock.json']).toString().trim().split('\n').filter(Boolean)){
  const base=blob(pins.judgedTrackA,p),theirs=blob(pins.ownerTrackA,p),ours=existsSync(join(stage,p))?read(join(stage,p)):null;
  if(!theirs)throw Error('Owner deletion requires explicit review: '+p);
  let final;
  if(!ours || (base&&ours.equals(base))) final=theirs;
  else if(ours.equals(theirs))final=ours;
  else {
   if(!base)throw Error('Concurrent owner addition: '+p);
   const m=mkdtempSync(join(tmpdir(),'autonomy-refresh-'));
   for(const [n,b]of [['ours',ours],['base',base],['theirs',theirs]])write(join(m,n),b);
   try{final=exec('git',['merge-file','-p',join(m,'ours'),join(m,'base'),join(m,'theirs')],{maxBuffer:16*1024*1024});}catch{throw Error('Owner refresh conflict: '+p);}
  }
  put(stage,p,final);refreshed.push({path:p,ownerSha256:sha(theirs),composedSha256:sha(final)});
 }
 // Only missing current core files are added. Existing A runtime/spec/manifests cannot be replaced.
 const addedCore=[];
 for(const p of (includeCore ? git(['ls-tree','-r','--name-only',pins.core,'packages/core/src']).toString().trim().split('\n') : [])){
  if(!existsSync(join(stage,p))){put(stage,p,blob(pins.core,p));addedCore.push(p);}
 }
 const report='packages/core/src/reporting/render.ts';
 if(!read(join(stage,report)).equals(read(join(root,'docs/track-b-judged-release/source',report))))throw Error('8e648 report snapshot delta lost');
 const baselineInventory=Object.fromEntries(walk(stage).filter(p=>!p.startsWith('.git/')).map(p=>[p,sha(read(join(stage,p)))]));
 const adoptionPaths=[];
 if(includeAdoption){
  for(const p of walk(join(here,'source'))){if(existsSync(join(stage,p)))throw Error('Adoption is addition-only: '+p);put(stage,p,read(join(here,'source',p)));adoptionPaths.push(p);}
  const ownerAdapter='apps/web/src/server/autonomous-company.ts';
  if(existsSync(join(stage,ownerAdapter)))throw Error('Existing autonomy adapter');
  put(stage,ownerAdapter,read(join(root,'docs/autonomous-company-integration/source',ownerAdapter)));adoptionPaths.push(ownerAdapter);
  put(stage,'owner-migrations/autonomy-release.operations.sql',read(join(stage,'packages/core/src/agents/autonomy/operations.sql')));
  // Extract literal SQL without importing TypeScript or executing application code.
  const source=read(join(stage,'packages/core/src/agents/autonomy/communications.ts'),'utf8');
  const sql=source.match(/export const AUTONOMY_COMMUNICATIONS_SQL = `([\s\S]*?)`;/)?.[1];if(!sql)throw Error('Communications SQL shape changed');
  put(stage,'owner-migrations/autonomy-release.communications.sql',sql);
  put(stage,'owner-migrations/autonomy-release.access.sql',read(join(here,'source/apps/web/src/server/autonomy-release.sql')));
  const migrations=[['autonomy-release.operations','owner-migrations/autonomy-release.operations.sql',['agent.persistence.001','data.operations.002']],['autonomy-release.communications','owner-migrations/autonomy-release.communications.sql',['autonomy-release.operations']],['autonomy-release.access','owner-migrations/autonomy-release.access.sql',['autonomy-release.communications']]].map(([id,path,after])=>({id,path,after,sha256:sha(read(join(stage,path))),transactionOwner:'owner-runner',executed:false}));
  put(stage,'owner-migrations/autonomy-release.json',JSON.stringify({namespace:'autonomy-release',existingRegistryUnchanged:true,prerequisiteIdentityMappingRequired:true,migrations},null,2)+'\n');
  adoptionPaths.push(...migrations.map(m=>m.path),'owner-migrations/autonomy-release.json');
 }
 const result={...historical,stage,adoptionPins:pins,refreshed,addedCore,baselineInventory,adoptionPaths,liveAcceptance:{conditional:{target:77,gateway:50,naive:10},approved:{target:32,gateway:16,naive:0}},releaseAccepted:false,liveRunPerformed:false};
 write(join(stage,'FINAL-COMPOSITION.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageAutonomy(process.argv.includes('--baseline')?{includeAdoption:false,includeCore:false}:{}),null,2));
