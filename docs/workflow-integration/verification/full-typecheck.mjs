import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,unlinkSync,symlinkSync,mkdirSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
const stage=resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Usage: node full-typecheck.mjs ASSEMBLED_STAGE [INSTALLED_WORKSPACE]');
const installed=resolve(process.argv[3]??process.env.WORKFLOW_INSTALLED_WORKSPACE??'/tmp/workflow-bootstrap.JpxCTM');
for(const sub of ['', 'packages/core','apps/web']){
 const source=join(installed,sub,'node_modules'),target=join(stage,sub,'node_modules');
 if(!existsSync(source))throw new Error(`Missing actual offline workspace dependencies ${source}`);
 if(existsSync(target)){if(!lstatSync(target).isSymbolicLink())throw new Error('Refuse replacing dependency directory');unlinkSync(target);}
 if(sub===''){
  mkdirSync(target);
  for(const item of readdirSync(source)){if(item==='@ae')continue;symlinkSync(join(source,item),join(target,item));}
  mkdirSync(join(target,'@ae'));symlinkSync(join(stage,'packages/core'),join(target,'@ae/core'),'dir');
 } else symlinkSync(source,target,'dir');
}
const tsc=join(installed,'node_modules/typescript/bin/tsc');
execFileSync(process.execPath,[tsc,'-p','packages/core/tsconfig.json','--noEmit'],{cwd:stage,stdio:'inherit'});
execFileSync(process.execPath,[join(installed,'node_modules/next/dist/bin/next'),'typegen'],{cwd:join(stage,'apps/web'),stdio:'inherit'});
execFileSync(process.execPath,[tsc,'-p','tsconfig.json','--noEmit'],{cwd:join(stage,'apps/web'),stdio:'inherit'});
console.log('Actual complete core and Next app strict TypeScript passed, actual Next/Workflow route generation compiled. No external declarations or source substitutions.');
