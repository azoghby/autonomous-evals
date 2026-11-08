import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const stage = mkdtempSync(join(tmpdir(), 'data-production-intake-'));
execFileSync('tar', ['-x', '-C', stage], { input: execFileSync('git', ['archive', 'f0068733ca49c37f40fd7de279325f21a4b5fbbb'], {cwd:root, maxBuffer:100_000_000}) });
execFileSync('git', ['apply', '--check', join(here, 'track-a.patch')], {cwd:stage});
execFileSync('git', ['apply', join(here, 'track-a.patch')], {cwd:stage});
for (const [source, applied] of [['data-production.ts','apps/web/src/server/data-production.ts'],['route.ts','apps/web/src/app/api/jobs/[jobId]/data-review/route.ts']]) {
  if (readFileSync(join(here,'source',source),'utf8') !== readFileSync(join(stage,applied),'utf8')) throw new Error('Patch/source mismatch');
}
// Main core prerequisites are overlaid only in this disposable validation directory.
cpSync(join(root,'packages/core/src/evals'), join(stage,'packages/core/src/evals'), {recursive:true});
cpSync(join(root,'packages/core/src/agents'), join(stage,'packages/core/src/agents'), {recursive:true});
cpSync(join(root,'packages/core/src/targets'), join(stage,'packages/core/src/targets'), {recursive:true});
const deps = process.env.DATA_INTAKE_NODE_MODULES || '/tmp/track-b-harness/node_modules';
symlinkSync(deps,join(stage,'node_modules'),'dir');
// Structural fixture declarations only for external runtime boundaries. Actual engine modules are typechecked.
const fixtures = join(stage,'data-intake-fixtures'); mkdirSync(fixtures);
writeFileSync(join(fixtures,'boundaries.ts'), `import type { AgentTaskRunner } from '../packages/core/src/agents/session-service';
export declare function buildAgentDeps(): Promise<{runner: AgentTaskRunner}>;
export declare function getCurrentCustomer(): Promise<{id:string; isOperator:boolean}|null>;
export declare class Pool { constructor(options:{connectionString:string;max:number}); connect():Promise<any>; query<T>(sql:string, params?:unknown[]):Promise<{rows:T[]}>; }
`);
writeFileSync(join(fixtures,'ambient.d.ts'), `declare module 'server-only';`);
// Pin aliases at the unavailable live SDK and session boundary; do not claim full Next/Neon compatibility.
const config = {compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,skipLibCheck:true,noEmit:true,types:['node'],baseUrl:stage,paths:{
'@ae/core/integration/eval-services':['data-intake-fixtures/boundaries.ts'],
'@neondatabase/serverless':['data-intake-fixtures/boundaries.ts'],
'@ae/core/*':['packages/core/src/*'],
'@/server/data-production':['apps/web/src/server/data-production.ts'],
}},files:['apps/web/src/server/data-production.ts','apps/web/src/app/api/jobs/[jobId]/data-review/route.ts','data-intake-fixtures/ambient.d.ts']};
// Replace only staged session dependency with a structural fixture, leaving patch bytes untouched elsewhere.
writeFileSync(join(stage,'apps/web/src/server/session.ts'), `export {getCurrentCustomer} from '../../../../data-intake-fixtures/boundaries';\n`);
writeFileSync(join(stage,'tsconfig.data-intake.json'),JSON.stringify(config,null,2));
execFileSync(join(deps,'.bin/tsc'),['-p',join(stage,'tsconfig.data-intake.json')],{cwd:stage,stdio:'inherit'});
cpSync(join(here,'source/data-production.test.ts'),join(stage,'apps/web/src/server/data-production.test.ts'));
cpSync(join(here,'source/route.test.ts'),join(stage,'apps/web/src/app/api/jobs/[jobId]/data-review/route.test.ts'));
writeFileSync(join(fixtures,'neon.ts'),'export class Pool {}');
writeFileSync(join(fixtures,'server-only.ts'),'export {};');
writeFileSync(join(stage,'vitest.data-intake.config.mjs'), `export default {resolve:{alias:{'server-only':${JSON.stringify(join(fixtures,'server-only.ts'))},'@neondatabase/serverless':${JSON.stringify(join(fixtures,'neon.ts'))},'@ae/core/integration/eval-services':${JSON.stringify(join(fixtures,'boundaries.ts'))},'@ae/core':${JSON.stringify(join(stage,'packages/core/src'))},'@/server/data-production':${JSON.stringify(join(stage,'apps/web/src/server/data-production.ts'))}}},test:{include:['apps/web/src/app/api/jobs/**/data-review/route.test.ts','apps/web/src/server/data-production.test.ts']}};`);
execFileSync(join(deps,'.bin/vitest'), ['run','--config','vitest.data-intake.config.mjs'], {cwd:stage,stdio:'inherit'});
console.log(`Exact-base apply check and targeted TypeScript passed. Stage: ${stage}`);
