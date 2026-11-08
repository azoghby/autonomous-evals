import {join} from 'node:path';
import {mkdirSync,symlinkSync,readdirSync,writeFileSync,copyFileSync,readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),stage=process.env.JUDGED_STAGE,installed=process.env.WORKFLOW_INSTALLED_WORKSPACE??'/tmp/workflow-bootstrap.JpxCTM',deps=join(installed,'node_modules');
mkdirSync(join(stage,'node_modules/@ae'),{recursive:true});
for(const name of readdirSync(deps))if(name!=='@ae'&&!existsSync(join(stage,'node_modules',name)))symlinkSync(join(deps,name),join(stage,'node_modules',name));
if(!existsSync(join(stage,'node_modules/@ae/core')))symlinkSync(join(stage,'packages/core'),join(stage,'node_modules/@ae/core'),'dir');
for(const sub of ['apps/web','packages/core'])if(!existsSync(join(stage,sub,'node_modules')))symlinkSync(join(installed,sub,'node_modules'),join(stage,sub,'node_modules'),'dir');

mkdirSync(join(stage,'rerun-tests'));for(const f of readdirSync(join(root,'tests/track-b/workflow-rerun-integration')).filter(f=>f.endsWith('.test.ts')))writeFileSync(join(stage,'rerun-tests',f),readFileSync(join(root,'tests/track-b/workflow-rerun-integration',f),'utf8').replaceAll('006-workflow-finding-reruns.sql','008-workflow-finding-reruns.sql'));
writeFileSync(join(stage,'rerun-tests/empty.ts'),'export {};');
writeFileSync(join(stage,'ambient.d.ts'),"declare module 'server-only';");
writeFileSync(join(stage,'tsconfig.rerun.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,jsx:'react-jsx',types:['node'],paths:{'@ae/core/*':[join(stage,'packages/core/src/*')],'@/*':[join(stage,'apps/web/src/*')]}},files:['ambient.d.ts','apps/web/src/server/rich-rerun.ts','apps/web/src/server/job-actions.ts','apps/web/src/server/mcp-tools.ts','apps/web/src/app/api/jobs/[jobId]/findings/[findingId]/rerun/route.ts']},null,2));
execFileSync(process.execPath,[join(deps,'typescript/bin/tsc'),'-p','tsconfig.rerun.json'],{cwd:stage,stdio:'inherit'});
writeFileSync(join(stage,'vitest.rerun.config.mjs'),`export default {resolve:{alias:[{find:'server-only',replacement:${JSON.stringify(join(stage,'rerun-tests/empty.ts'))}},{find:'@/',replacement:${JSON.stringify(join(stage,'apps/web/src/'))}},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage,'packages/core/src/$1'))}}]},test:{include:['rerun-tests/*.test.ts'],maxWorkers:1}}`);
execFileSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--config','vitest.rerun.config.mjs','--reporter=default','--reporter=json','--outputFile.json=rerun-results.json'],{cwd:stage,stdio:'inherit',env:{...process.env,RERUN_STAGE:stage}});
const report=JSON.parse(readFileSync(join(stage,'rerun-results.json'),'utf8'));
if(report.numPassedTests!==12||report.numFailedTests||report.numPendingTests)throw Error('Original rerun assertion inventory changed');
writeFileSync(join(root,'tests/track-b/judged-release/evidence/rerun.json'),JSON.stringify({stage,strictTypeScript:'passed',finalComposition:'883d186a94ea38aeb122afeb9d9e9bd2ee0c6e24',offline:true,passed:report.numPassedTests,failed:report.numFailedTests,tests:report.testResults},null,2));
