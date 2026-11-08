import {stageComplete} from '../complete-workflow-integration/stage.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
export function files(dir,prefix='') {return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);}
export function stageResumption() {
 const manifest=JSON.parse(readFileSync(join(here,'SERIES.json'),'utf8'));
 if(manifest.parent!=='687b5086e6bd204fe82809672c0511e2ee3e6f52'||manifest.trackA!=='f0068733ca49c37f40fd7de279325f21a4b5fbbb'||manifest.core!=='e61ad9719a1f7cfc844523cffbd72253dcdcb30b')throw Error('Resumption pins changed');
 for(const [p,expected] of Object.entries(manifest.sha256))if(createHash('sha256').update(readFileSync(join(here,'../..',p))).digest('hex')!==expected)throw Error('Resumption input changed: '+p);
 const assembled=stageComplete();
 const paths=files(join(here,'source'));
 execFileSync('git',['apply','--check',join(here,'resumption.patch')],{cwd:assembled.stage});
 execFileSync('git',['apply',join(here,'resumption.patch')],{cwd:assembled.stage});
 for(const path of paths)if(!readFileSync(join(assembled.stage,path)).equals(readFileSync(join(here,'source',path))))throw Error('Patch source mismatch: '+path);
 return {...assembled,resumption:join(here,'resumption.patch'),resumptionHash:createHash('sha256').update(readFileSync(join(here,'resumption.patch'))).digest('hex')};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stageResumption()));
