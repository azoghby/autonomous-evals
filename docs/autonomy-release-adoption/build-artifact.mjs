import {execFileSync as exec} from 'node:child_process';
import {readFileSync as read,writeFileSync as write,mkdirSync,cpSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageAutonomy,pins,sha} from './stage.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const fresh=(baseline=false)=>JSON.parse(exec(process.execPath,[join(here,'stage.mjs'),...(baseline?['--baseline']:[])],{maxBuffer:32*1024*1024}).toString());
const baseline=fresh(true),full=fresh();
const paths=[...full.addedCore,...full.adoptionPaths];
for(const p of paths)if(existsSync(join(baseline.stage,p)))throw Error('Patch would replace owner file: '+p);
exec('git',['init','-q'],{cwd:baseline.stage});
for(const p of paths){mkdirSync(dirname(join(baseline.stage,p)),{recursive:true});cpSync(join(full.stage,p),join(baseline.stage,p));}
exec('git',['add','-N','--',...paths],{cwd:baseline.stage});
const patch=exec('git',['diff','--binary','--no-ext-diff','--',...paths],{cwd:baseline.stage,maxBuffer:32*1024*1024});
write(join(here,'application.patch'),patch);
// Fresh preserved-A baseline; --check then compare all bytes. No complete overlay is emitted.
const check=fresh(true);
exec('git',['apply','--check',join(here,'application.patch')],{cwd:check.stage});
exec('git',['apply',join(here,'application.patch')],{cwd:check.stage});
for(const p of paths)if(!read(join(check.stage,p)).equals(read(join(full.stage,p))))throw Error('Patch roundtrip mismatch: '+p);
for(const [p,h] of Object.entries(check.baselineInventory))if(p!=='FINAL-COMPOSITION.json'&&sha(read(join(check.stage,p)))!==h)throw Error('Baseline overwritten: '+p);
const metadata={pins,patch:'application.patch',sha256:sha(patch),paths:Object.fromEntries(paths.map(p=>[p,sha(read(join(full.stage,p)))])),refreshed:full.refreshed,baseline:'stageAutonomy({includeAdoption:false,includeCore:false})',verified:'git apply --check/apply on fresh judged + preserved 875ceef baseline; added bytes exact; every baseline byte retained',historicalArtifactsUnchanged:true,releaseAccepted:false};
write(join(here,'APPLICATION.json'),JSON.stringify(metadata,null,2)+'\n');console.log(JSON.stringify({stage:full.stage,paths:paths.length,sha256:metadata.sha256}));
