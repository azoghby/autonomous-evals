import {execFileSync as exec} from 'node:child_process';
import {readFileSync as read,writeFileSync as write,mkdirSync,cpSync,symlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {stageAutonomy,root} from '../../../docs/autonomy-release-adoption/stage.mjs';
const result=stageAutonomy(),{stage}=result,out=join(root,'tests/track-b/autonomy-release-adoption/evidence');mkdirSync(out,{recursive:true});
const deps=process.env.AUTONOMY_NODE_MODULES??'/tmp/sandbox-generation-deps.cBCEai/node_modules';
cpSync(join(root,'docs/autonomy-release-adoption/source'),join(stage,'docs/autonomy-release-adoption/source'),{recursive:true});
cpSync(join(root,'tests/track-b/autonomous-company'),join(stage,'tests/track-b/autonomous-company'),{recursive:true});
cpSync(join(root,'tests/track-b/autonomy-release-adoption'),join(stage,'tests/track-b/autonomy-release-adoption'),{recursive:true,filter:p=>!p.includes('/evidence')});
mkdirSync(join(stage,'node_modules'),{recursive:true});
// Build runner supplies complete Next dependencies later. Tests use isolated offline fixtures.
symlinkSync(deps,join(stage,'test-deps'));
write(join(stage,'autonomy-vitest.config.mjs'),`export default {resolve:{alias:{'@ae/core':${JSON.stringify(join(stage,'packages/core/src'))},'server-only':${JSON.stringify(join(stage,'empty-server-only.mjs'))}}},test:{include:['tests/track-b/autonomous-company/**/*.test.ts','tests/track-b/autonomy-release-adoption/**/*.test.ts'],maxWorkers:1}};`);
write(join(stage,'empty-server-only.mjs'),'export {};');
// Link dependency entries so transitive imports resolve without fetching/installing.
const {readdirSync}=await import('node:fs');
for(const tree of [join(process.env.WORKFLOW_INSTALLED_WORKSPACE??'/tmp/workflow-bootstrap.JpxCTM','node_modules'),deps])for(const e of readdirSync(tree)){
 if(e==='@ae')continue;
 if(e.startsWith('@')){mkdirSync(join(stage,'node_modules',e),{recursive:true});for(const n of readdirSync(join(tree,e)))if(!existsSync(join(stage,'node_modules',e,n)))symlinkSync(join(tree,e,n),join(stage,'node_modules',e,n));}
 else if(!existsSync(join(stage,'node_modules',e)))symlinkSync(join(tree,e),join(stage,'node_modules',e));
}
const env={...process.env,AUTONOMY_NODE_MODULES:deps,EXTENSION_STAGE:stage,EXTENSION_BUILD_OUTPUT:join(out,'build'),NEXT_TELEMETRY_DISABLED:'1',npm_config_offline:'true',PNPM_CONFIG_OFFLINE:'true'};
const commands=[];
function run(label,args,cwd=root){let log;try{log=exec(process.execPath,args,{cwd,env,encoding:'utf8',maxBuffer:64*1024*1024});commands.push({label,exit:0});}catch(e){log=(e.stdout??'')+(e.stderr??'');commands.push({label,exit:e.status});write(join(out,label+'.log'),log);write(join(out,'RESULTS.json'),JSON.stringify({stage,commands,releaseAccepted:false},null,2));throw e;}write(join(out,label+'.log'),log);console.log(label+'\n'+log.slice(-2500));}
run('sql-security',['--test','tests/track-b/autonomy-release-adoption/sql-security.test.mjs']);
write(join(stage,'tsconfig.autonomy-tests.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],paths:{'@ae/core/*':['./packages/core/src/*']}},include:['tests/track-b/autonomous-company/**/*.ts','tests/track-b/autonomy-release-adoption/**/*.ts','docs/autonomy-release-adoption/source/**/*.ts']}));
run('test-typecheck',[join(deps,'typescript/bin/tsc'),'-p',join(stage,'tsconfig.autonomy-tests.json')],stage);
run('company-and-server',[join(deps,'vitest/vitest.mjs'),'run','--root',stage,'--config',join(stage,'autonomy-vitest.config.mjs'),'--reporter=json','--outputFile.json='+join(out,'tests.json')],stage);
run('full-build',['tests/track-b/autonomy-release-adoption/build.mjs','--build-only']);
const buildLog=join(out,'build/next-workflow-build.log');write(buildLog,read(buildLog,'utf8').split(/\r?\n/).map(line=>line.trimEnd()).join('\n'));
write(join(out,'RESULTS.json'),JSON.stringify({pins:result.adoptionPins,stage,commands,releaseAccepted:false,liveRunPerformed:false},null,2)+'\n');
