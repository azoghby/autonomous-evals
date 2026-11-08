// Produce a single reviewable patch for an owner checkout at the exact current A pin.
import {execFileSync as exec} from 'node:child_process';
import {mkdtempSync,rmSync,cpSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {stageFinal,pins,root} from './stage.mjs';
const {stage}=stageFinal(),base=mkdtempSync(join(tmpdir(),'final-owner-patch-'));
const paths=['apps','packages','package.json','package-lock.json'];
exec('tar',['-x','-C',base],{input:exec('git',['archive',pins.trackA,...paths],{cwd:root,maxBuffer:128*1024*1024})});
exec('git',['init','-q'],{cwd:base});exec('git',['add','--',...paths],{cwd:base});
for(const p of [...paths,'owner-migrations']) {rmSync(join(base,p),{recursive:true,force:true});cpSync(join(stage,p),join(base,p),{recursive:true});}
exec('git',['add','-N','--',...paths,'owner-migrations'],{cwd:base});
const bytes=exec('git',['diff','--binary','--no-ext-diff','--',...paths,'owner-migrations'],{cwd:base,maxBuffer:64*1024*1024});
const file=join(root,'docs/track-b-final-composition/application.patch');writeFileSync(file,bytes);
// Check against a fresh archive; never apply to a real owner checkout.
const clean=mkdtempSync(join(tmpdir(),'final-owner-check-'));
exec('tar',['-x','-C',clean],{input:exec('git',['archive',pins.trackA,...paths],{cwd:root,maxBuffer:128*1024*1024})});
exec('git',['apply','--check',file],{cwd:clean});exec('git',['apply',file],{cwd:clean});
const inventory=JSON.parse(readFileSync(join(stage,'APPLICATION-SHA256.json')));
for(const [p,h]of Object.entries(inventory).filter(([p])=>paths.some(a=>p===a||p.startsWith(a+'/'))||p.startsWith('owner-migrations/'))){if(createHash('sha256').update(readFileSync(join(clean,p))).digest('hex')!==h)throw Error('Owner patch source mismatch: '+p);}
const actual=[];function files(dir,p){for(const e of readdirSync(dir,{withFileTypes:true})){const path=p+'/'+e.name;if(e.isDirectory())files(join(dir,e.name),path);else if(e.isFile())actual.push(path);}}
for(const p of [...paths,'owner-migrations']){if(p.includes('.json'))actual.push(p);else files(join(clean,p),p);}
const expected=Object.keys(inventory).filter(p=>paths.some(a=>p===a||p.startsWith(a+'/'))||p.startsWith('owner-migrations/')).sort();
if(JSON.stringify(actual.sort())!==JSON.stringify(expected))throw Error('Owner patch inventory includes stale/missing source files');
writeFileSync(join(root,'docs/track-b-final-composition/APPLICATION.json'),JSON.stringify({pins,patch:'application.patch',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,applicationInventorySha256:createHash('sha256').update(readFileSync(join(stage,'APPLICATION-SHA256.json'))).digest('hex'),verified:'Fresh pinned A archive git apply --check/apply and every delivered source byte compared',noDeployment:true},null,2)+'\n');
console.log(file);
