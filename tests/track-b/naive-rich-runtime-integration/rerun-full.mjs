// Supplement a completed source/types/build validation with a previously omitted committed test fixture.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../..'),sha=b=>createHash('sha256').update(b).digest('hex');
const priorBytes=readFileSync(join(here,'PRE-FIXTURE-RESULTS.json')),prior=JSON.parse(priorBytes),stage=prior.stage;
if([prior.build,prior.typegen,prior.coreTypecheck,prior.typecheck,prior.tests].some(s=>s!==0))throw Error('Prior source validation incomplete');
const combinedBytes=readFileSync(join(repo,'docs/naive-text-adoption-integration/manifest.json'));
if(sha(combinedBytes)!==prior.combinedManifestSha256)throw Error('Candidate changed');
const combined=JSON.parse(combinedBytes),support=JSON.parse(readFileSync(join(here,'SUPPORT-PINS.json')));
function verify(){for(const p of [...support,...combined.files.map(p=>({path:p.path,sha256:p.afterSha256}))])if(sha(readFileSync(join(stage,p.path)))!==p.sha256)throw Error('Stage source changed '+p.path);}
verify();
const path='tests/track-b/trace-acceptance.json',blob=spawnSync('git',['show',prior.base+':'+path],{cwd:repo});
if(blob.status!==0)throw Error(blob.stderr.toString());
const fixture={path,sourceCommit:prior.base,sha256:sha(blob.stdout)};
mkdirSync(dirname(join(stage,path)),{recursive:true});writeFileSync(join(stage,path),blob.stdout);support.push(fixture);
const harnessPins=readdirSync(here).filter(p=>/\.(?:test\.ts|mjs)$/.test(p)).map(path=>({path,sha256:sha(readFileSync(join(here,path)))}));
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:'/tmp',TZ:'UTC',NODE_ENV:'test'};
const result=spawnSync('npm',['test','--','--maxWorkers=2','--reporter=json','--outputFile=full-fixture-results.json'],{cwd:stage,encoding:'utf8',env});
writeFileSync(join(stage,'full-fixture-tests.log'),result.stdout+result.stderr);
const report=JSON.parse(readFileSync(join(stage,'full-fixture-results.json')));
verify();for(const p of harnessPins)if(sha(readFileSync(join(here,p.path)))!==p.sha256)throw Error('Harness changed');
if(sha(readFileSync(join(repo,'docs/naive-text-adoption-integration/manifest.json')))!==prior.combinedManifestSha256)throw Error('Candidate changed during tests');
const fullTests={status:result.status,passed:report.numPassedTests,failed:report.numFailedTests,pending:report.numPendingTests,failedSuites:report.numFailedTestSuites,success:report.success};
const next={...prior,harnessPins,fullTests,supplementalSourceFiles:[fixture],validationSteps:[{kind:'source-types-build-and-focused',receipt:'PRE-FIXTURE-RESULTS.json',sha256:sha(priorBytes),harnessPins:prior.harnessPins,typegen:prior.typegen,coreTypecheck:prior.coreTypecheck,typecheck:prior.typecheck,build:prior.build,focusedPassed:prior.passed},{kind:'original-npm-with-committed-fixture',harnessPins,sourceUnchanged:true,fullTests}],intentionalSkips:report.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='skipped').map(t=>t.fullName))};
writeFileSync(join(here,'SUPPORT-PINS.json'),JSON.stringify(support,null,2)+'\n');writeFileSync(join(here,'RESULTS.json'),JSON.stringify(next,null,2)+'\n');console.log(JSON.stringify({stage,fixture,fullTests},null,2));
if(result.status!==0||report.numFailedTests||report.numFailedTestSuites||!report.success)process.exitCode=1;
