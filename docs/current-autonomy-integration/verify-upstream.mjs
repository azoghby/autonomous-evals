// Read-only provenance reproduction. Never stages a historical overlay onto current source.
import {execFileSync as exec} from 'node:child_process';
import {readFileSync as read} from 'node:fs';
import {join} from 'node:path';
import {stagePaid} from '../autonomy-paid-app-integration/stage.mjs';
import {root,here,parent,sha} from './stage.mjs';
const manifest=JSON.parse(read(join(here,'DEPENDENCIES.json'))),historical=stagePaid();
for(const[p,h]of Object.entries(manifest.paths)){
 let exists=false;try{exec('git',['cat-file','-e',parent+':'+p],{cwd:root,stdio:'pipe'});exists=true;}catch{}
 if(exists)throw Error('Dependency overlaps parent: '+p);
 const upstream=read(join(historical.stage,p)),retained=read(join(here,'dependencies',p));
 if(!upstream.equals(retained)||sha(retained)!==h.sha256)throw Error('Upstream dependency drift: '+p);
}
console.log(JSON.stringify({parent,verifiedDependencies:Object.keys(manifest.paths).length,upstreamStage:historical.stage,coreAdditions:0}));
