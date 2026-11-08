import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareComparison} from './prepare.mjs';

const root=resolve(fileURLToPath(new URL('../../../..',import.meta.url)));
const result=process.env.EXTENSION_STAGE?{stage:resolve(process.env.EXTENSION_STAGE)}:(await import('../../../../docs/track-b-release-extensions/stage.mjs')).stageExtended();
const {stage}=result;
const installed=resolve(process.env.WORKFLOW_INSTALLED_WORKSPACE??'/tmp/workflow-bootstrap.JpxCTM');
const deps=join(installed,'node_modules');
const out=resolve(process.env.EXTENSION_COMPARISON_OUTPUT??join(root,'tests/track-b/release-extensions/comparison/evidence/comparison'));
mkdirSync(out,{recursive:true});
const config=prepareComparison(stage,root);
const setup=spawnSync(process.execPath,[join(root,'tests/track-b/workflow-comparison-integration/typecheck.mjs'),stage],{stdio:'inherit'});
if(setup.status!==0)throw Error('Combined comparison strict typecheck failed');
const run=spawnSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--config',config,'--reporter=default','--reporter=json',`--outputFile.json=${join(out,'results.json')}`],{cwd:stage,encoding:'utf8',maxBuffer:16*1024*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR}});
writeFileSync(join(out,'tests.log'),(run.stdout??'')+(run.stderr??''));
process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');
if(run.status!==0)throw Error(`Combined comparison suite failed (${run.status})`);
const r=JSON.parse(readFileSync(join(out,'results.json'),'utf8'));
if(r.numPassedTests!==16||r.testResults.length!==3||r.numFailedTests||r.numPendingTests||r.numTodoTests)throw Error('Original 15 comparison assertions plus approved-suite reuse regression missing, skipped, or failed');
for(const [file,count]of [['app.test.ts',12],['routes.test.ts',3],['monitoring-reuse.test.ts',1]]){
 const retained=r.testResults.find(f=>f.name.endsWith('/comparison-tests/'+file));
 if(retained?.assertionResults.length!==count||retained.assertionResults.some(a=>a.status!=='passed'))throw Error('Required comparison assertion inventory changed: '+file);
}
console.log(JSON.stringify({stage,passed:r.numPassedTests,skipped:r.numPendingTests,offline:true}));
