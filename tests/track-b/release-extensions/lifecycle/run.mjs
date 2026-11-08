import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readdirSync,symlinkSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {stageExtended} from '../../../../docs/track-b-release-extensions/stage.mjs';
import {prepareLifecycleTests} from './prepare.mjs';
const root=resolve(import.meta.dirname,'../../../..');
const result=stageExtended(),{stage}=result;
const installed=resolve(process.env.WORKFLOW_INSTALLED_WORKSPACE??'/tmp/workflow-bootstrap.JpxCTM'),deps=join(installed,'node_modules');
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});
for(const name of readdirSync(deps))if(name!=='@ae'&&!existsSync(join(stage,'node_modules',name)))symlinkSync(join(deps,name),join(stage,'node_modules',name));
symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'));
for(const sub of ['apps/web','packages/core'])if(existsSync(join(installed,sub,'node_modules')))symlinkSync(join(installed,sub,'node_modules'),join(stage,sub,'node_modules'));
const migrationNames=Object.fromEntries(Object.entries(result.migrations.migrationRenames).map(([a,b])=>[a.split('/').at(-1),b.split('/').at(-1)]));
const prepared=prepareLifecycleTests(stage,root,migrationNames);
const results=[];
const original=JSON.parse(readFileSync(join(root,'docs/workflow-resumption-integration/RESULTS.json'),'utf8'));
let originalResumptionTests=0;
for(const [i,config]of prepared.configs.entries()) {
 const report=join(stage,`lifecycle-${i}.json`);
 const r=spawnSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--config',config,'--reporter=default','--reporter=json',`--outputFile.json=${report}`],{cwd:stage,env:{...process.env,...prepared.env,PACK_TRACK_A_REVISION:result.pins.trackB},encoding:'utf8',maxBuffer:32*1024*1024});
 process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');
 const parsed=existsSync(report)?JSON.parse(readFileSync(report,'utf8')):null;
 if(i===0&&parsed){for(const old of original.files){const mapped=old.file.replace('bridge-verification/','final-verification/bridge/').replace('complete-verification/','final-verification/complete/').replace('remediation-verification/','final-verification/remediation/').replace('resumption-verification/','final-verification/resumption/');const retained=parsed.testResults.find(f=>f.name.endsWith('/'+mapped));if(!retained||retained.assertionResults.length<old.tests)throw Error('Historical resumption coverage missing: '+old.file);originalResumptionTests+=old.tests;}if(originalResumptionTests!==140)throw Error('Historical 140-test inventory changed');}
 results.push({config,status:r.status,passed:parsed?.numPassedTests,failed:parsed?.numFailedTests,skipped:parsed?.numPendingTests});
 writeFileSync(join(import.meta.dirname,'RESULTS.json'),JSON.stringify({stage,pins:result.pins,originalResumptionTests,results},null,2)+'\n');
 if(r.status!==0||!parsed?.numPassedTests||parsed.numFailedTests||parsed.numPendingTests)throw Error(`Lifecycle suite failed; stage retained ${stage}`);
}
