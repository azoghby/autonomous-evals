import {execFileSync as exec} from 'node:child_process';
import {copyFileSync,writeFileSync,symlinkSync,existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageProjection} from './stage.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const deps=process.env.WORKFLOW_NODE_MODULES ?? '/Users/alexzoghby/.t3/worktrees/YC Hackathon 2/t3-6dfdf18b/tests/track-b/node_modules';
for(const dep of ['vitest','typescript','zod','@electric-sql/pglite'])if(!existsSync(join(deps,dep,'package.json')))throw Error('Set WORKFLOW_NODE_MODULES to existing offline dependencies');
const assembled=stageProjection();const {stage}=assembled;
symlinkSync(deps,join(stage,'node_modules'),'dir');writeFileSync(join(stage,'package.json'),'{"type":"module","private":true}');
for(const file of ['fixture.ts','projection.test.ts','route.test.ts','storage.test.ts'])copyFileSync(join(here,file),join(stage,file));
writeFileSync(join(stage,'empty.ts'),'export {};');
const alias=[{find:'server-only',replacement:join(stage,'empty.ts')},{find:'@/',replacement:join(stage,'apps/web/src/')},{find:/^@ae\/core\/(.*)$/,replacement:join(stage,'packages/core/src/$1')}];
// RegExp cannot be JSON encoded.
writeFileSync(join(stage,'vitest.config.mjs'),`export default {resolve:{alias:[${JSON.stringify(alias[0])},${JSON.stringify(alias[1])},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(alias[2].replacement)}}]},test:{include:['projection.test.ts','route.test.ts','storage.test.ts'],maxWorkers:1}};`);
writeFileSync(join(stage,'tsconfig.projection.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,types:['node'],baseUrl:stage,paths:{'@ae/core/*':['packages/core/src/*']}},include:['apps/web/src/server/workflow-pack-projection.ts','fixture.ts','projection.test.ts','storage.test.ts','apps/web/src/server/rich-artifacts.ts']}));
exec(process.execPath,[join(deps,'typescript/bin/tsc'),'-p','tsconfig.projection.json'],{cwd:stage,stdio:'inherit'});
exec(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--config','vitest.config.mjs'],{cwd:stage,stdio:'inherit',env:{...process.env,PROJECTION_ROOT:resolve(here,'../../..')}});
console.log(JSON.stringify(assembled));
