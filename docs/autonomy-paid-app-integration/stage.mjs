import {execFileSync as exec} from 'node:child_process';
import {readFileSync as read,writeFileSync as write,mkdirSync,readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageAutonomy,root,sha,pins as basePins} from '../autonomy-release-adoption/stage.mjs';
export {root,sha};
export const pins=Object.freeze({...basePins,sharedBudgetCore:'0f1fe3cb5c11eb20477eace00a0447a56e728bac'});
const here=dirname(fileURLToPath(import.meta.url));
const walk=(d,p='')=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name),p+e.name+'/'):[p+e.name]);
/** The old artifact stays immutable. This stage explicitly changes only inventoried application
 * callers and the exact helper delta; it never refreshes Track A/manifests implicitly. */
export function stagePaid({includePaid=true}={}) {
 const base=stageAutonomy(),{stage}=base;
 const baselineInventory=Object.fromEntries(walk(stage).filter(p=>p!=='FINAL-COMPOSITION.json'&&!p.startsWith('.git/')).map(p=>[p,sha(read(join(stage,p)))]));
 const changedPaths=walk(join(here,'source'));
 const helper='packages/core/src/agents/autonomy/budget.ts';
 const exact=exec('git',['show',pins.sharedBudgetCore+':'+helper],{cwd:root});
 if(!read(join(here,'source',helper)).equals(exact))throw Error('Exact main helper bytes changed');
 if(includePaid)for(const p of changedPaths){mkdirSync(dirname(join(stage,p)),{recursive:true});write(join(stage,p),read(join(here,'source',p)));}
 const result={...base,paidPins:pins,paidBaselineInventory:baselineInventory,paidPaths:changedPaths,paidApplied:includePaid,releaseAccepted:false,liveRunPerformed:false};
 write(join(stage,'FINAL-COMPOSITION.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(stagePaid({includePaid:!process.argv.includes('--baseline')})));
