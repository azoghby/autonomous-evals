import { execFileSync as exec } from 'node:child_process';
import { readFileSync as read, writeFileSync as write, readdirSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stageCurrent, sha } from '../current-autonomy-integration/stage.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const walk=(d,p='')=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name),p+e.name+'/'):[p+e.name]);
export function stageCalendar({out}={}) {
 const candidate=JSON.parse(read(join(here,'../current-autonomy-integration/CANDIDATE.json')));
 for(const name of ['config','dependencies','application']) {
  if(sha(read(join(here,'../current-autonomy-integration',name+'.patch')))!==candidate.patchHashes[name]) throw Error('Candidate patch drift: '+name);
 }
 const priorGitDir=process.env.GIT_DIR;
 if(process.env.CALENDAR_ARCHIVE_GIT_DIR)process.env.GIT_DIR=process.env.CALENDAR_ARCHIVE_GIT_DIR;
 let base;
 try {
  if(process.env.CALENDAR_RETAINED_STAGE) {
   const preservation=JSON.parse(read(join(here,'../current-autonomy-integration/PRESERVATION.json')));
   const application=JSON.parse(read(join(here,'../current-autonomy-integration/APPLICATION.json')));
   const stage=out?resolve(out):mkdtempSync(join(tmpdir(),'current-calendar-retained-'));
   if(existsSync(stage)&&readdirSync(stage).length)throw Error('Output must be empty: '+stage);
   mkdirSync(stage,{recursive:true});
   base={parent:application.parent,stage,preserved:preservation.inventory,changes:application.changes,additions:application.additions};
   for(const [p,h] of Object.entries({...base.preserved,...base.changes,...base.additions})) {
    if(p.startsWith('/')||p.split('/').includes('..'))throw Error('Unsafe candidate path');
    const bytes=read(join(process.env.CALENDAR_RETAINED_STAGE,p));
    if(sha(bytes)!==h.sha256||bytes.length!==h.bytes)throw Error('Retained candidate drift: '+p);
    mkdirSync(dirname(join(stage,p)),{recursive:true});write(join(stage,p),bytes);
   }
   write(join(stage,'CURRENT-COMPOSITION.json'),JSON.stringify(base,null,2)+'\n');
  } else base=stageCurrent({out});
 }
 finally { if(priorGitDir===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=priorGitDir; }
 const source=join(here,'source');
 const paths=walk(source);
 const patch=join(here,'calendar.patch');
 const before=Object.fromEntries(paths.map(p=>[p,sha(read(join(base.stage,p)))]));
 exec('git',['apply','--check',patch],{cwd:base.stage});
 exec('git',['apply',patch],{cwd:base.stage});
 const changes={};
 for(const p of paths) {
  const bytes=read(join(base.stage,p)), expected=read(join(source,p));
  if(!bytes.equals(expected))throw Error('Patch/source mismatch: '+p);
  changes[p]={preimageSha256:before[p],sha256:sha(bytes),bytes:bytes.length};
 }
 // Every candidate byte outside the explicit patch targets must survive unchanged.
 for(const [p,v] of Object.entries({...base.preserved,...base.changes,...base.additions})) {
  if(!changes[p]&&sha(read(join(base.stage,p)))!==v.sha256) throw Error('Candidate preservation drift: '+p);
 }
 const manifestPath=join(here,'APPLICATION.json');
 if(existsSync(manifestPath)) {
  const expected=JSON.parse(read(manifestPath));
  if(expected.patchSha256!==sha(read(patch)) || JSON.stringify(expected.changes)!==JSON.stringify(changes)) throw Error('Calendar application manifest drift');
 }
 const result={stage:base.stage,parent:base.parent,candidateCommit:'f88811c8fb7509dc5996bb8cd1d148e4c23f3de3',patchSha256:sha(read(patch)),stagingMode:process.env.CALENDAR_RETAINED_STAGE?'verified-retained-candidate':'fresh-git-archive',changes,preservedCandidateFiles:Object.keys({...base.preserved,...base.changes,...base.additions}).length-paths.length,releaseAccepted:false,liveRunPerformed:false};
 write(join(base.stage,'CALENDAR-COMPOSITION.json'),JSON.stringify(result,null,2)+'\n');
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const i=process.argv.indexOf('--out');
 console.log(JSON.stringify(stageCalendar({out:i<0?undefined:process.argv[i+1]})));
}
