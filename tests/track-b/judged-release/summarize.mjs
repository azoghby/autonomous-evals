import {readFileSync as read,writeFileSync as write,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const dir=new URL('./evidence/',import.meta.url),json=p=>JSON.parse(read(new URL(p,dir)));
const judging=json('judging/tests.json'),rerun=json('rerun.json'),comparison=json('comparison.json'),main=json('build/tests-0.json'),chat=json('build/tests-1.json'),build=json('build/RESULTS.json');
for(const [r,n] of [[judging,314],[comparison,18],[main,214],[chat,7]]){assert.equal(r.numPassedTests,n);assert.equal(r.numFailedTests,0);assert.equal(r.numPendingTests,0);}
assert.equal(rerun.passed,12);assert.equal(rerun.failed,0);
assert(build.commands.every(c=>c.exit===0));
const historical=JSON.parse(read(new URL('../../../docs/workflow-resumption-integration/RESULTS.json',import.meta.url)));
let retained=0;for(const old of historical.files){const p=old.file.replace('bridge-verification/','final-verification/bridge/').replace('complete-verification/','final-verification/complete/').replace('remediation-verification/','final-verification/remediation/').replace('resumption-verification/','final-verification/resumption/');const file=main.testResults.find(f=>f.name.endsWith('/'+p));assert(file&&file.assertionResults.length>=old.tests);assert(file.assertionResults.every(a=>a.status==='passed'));retained+=old.tests;}
assert.equal(retained,140);
const reporting=judging.testResults.filter(f=>f.name.includes('/reporting/')).reduce((n,f)=>n+f.assertionResults.length,0);assert.equal(reporting,108);
const controlled=read(new URL('controlled-remediation.log',dir),'utf8');assert(controlled.includes('ℹ pass 9')&&controlled.includes('ℹ fail 0')&&controlled.includes('ℹ skipped 0'));
const summary={releaseAccepted:false,liveRunPerformed:false,offline:true,tests:{judgingRetained:200,newProductionIntegration:6,reporting:108,rerun:12,comparisonWithCostAndMonitoringRegressions:18,controlledRemediation:9,lifecycle:214,chat:7,calendar:16,totalExecutions:590,uniqueTestCountClaimed:false,historicalResumptionSubsetAudited:140},buildCommands:build.commands,versions:build.versions,artifact:JSON.parse(read(new URL('../../../docs/track-b-judged-release/APPLICATION.json',import.meta.url))),remainingGates:'See docs/track-b-judged-release/README.md; approved live caps remain32target/16Gateway and full77/48 plan refuses.'};
write(new URL('SUMMARY.json',dir),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary.tests));

// Normalize terminal trailing whitespace in fresh text logs; JSON assertion evidence stays exact.
function clean(url){for(const e of readdirSync(url,{withFileTypes:true})){const p=new URL(e.name+(e.isDirectory()?'/':''),url);if(e.isDirectory())clean(p);else if(e.name.endsWith('.log'))write(p,read(p,'utf8').split(/\r?\n/).map(l=>l.trimEnd()).join('\n').trimEnd()+'\n');}}clean(dir);
