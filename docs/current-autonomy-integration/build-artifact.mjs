import {execFileSync as exec} from 'node:child_process';
import {readFileSync as read,writeFileSync as write,mkdirSync,cpSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {stageCurrent,here,parent,sha} from './stage.mjs';
const base=stageCurrent({baseline:true}),full=stageCurrent();
exec('git',['init','-q'],{cwd:base.stage});
exec('git',['add','--',...Object.keys(full.changes)],{cwd:base.stage});
const groups={config:Object.keys(full.changes),dependencies:Object.keys(full.additions).filter(p=>full.additions[p].origin==='dependencies'),application:Object.keys(full.additions).filter(p=>full.additions[p].origin==='source')};
for(const p of [...Object.keys(full.changes),...Object.keys(full.additions)]){mkdirSync(dirname(join(base.stage,p)),{recursive:true});cpSync(join(full.stage,p),join(base.stage,p));}
exec('git',['add','-N','--',...Object.keys(full.additions)],{cwd:base.stage});
const patches={};for(const [name,paths]of Object.entries(groups)){
 const bytes=exec('git',['diff','--binary','--no-ext-diff','--',...paths],{cwd:base.stage,maxBuffer:64*1024*1024});
 write(join(here,name+'.patch'),bytes);patches[name]={sha256:sha(bytes),paths};
}
const check=stageCurrent({baseline:true});
for(const name of Object.keys(groups))for(const mode of [['--check'],[]])exec('git',['apply',...mode,join(here,name+'.patch')],{cwd:check.stage});
for(const[p,h]of Object.entries(full.additions))if(sha(read(join(check.stage,p)))!==h.sha256)throw Error('Patch postimage mismatch: '+p);
for(const[p,h]of Object.entries(full.changes))if(sha(read(join(check.stage,p)))!==h.sha256)throw Error('Config postimage mismatch: '+p);
for(const[p,h]of Object.entries(full.preserved))if(sha(read(join(check.stage,p)))!==h.sha256)throw Error('Patch overwrote parent: '+p);
write(join(here,'APPLICATION.json'),JSON.stringify({parent,patches,changes:full.changes,additions:full.additions,preservedFiles:full.preservedFiles,preservedBytes:full.preservedBytes,verified:'fresh exact-parent archive, sequential check/apply, every original and added byte compared',releaseAccepted:false},null,2)+'\n');
write(join(here,'PRESERVATION.json'),JSON.stringify({parent,files:full.preservedFiles,bytes:full.preservedBytes,sha256:sha(Buffer.from(JSON.stringify(full.preserved))),changes:full.changes,inventory:full.preserved},null,2)+'\n');
console.log(JSON.stringify({stage:full.stage,preservedFiles:full.preservedFiles,preservedBytes:full.preservedBytes,additions:Object.keys(full.additions).length}));
