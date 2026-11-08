import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageBridge } from '../stage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const deps = resolve(process.env.BRIDGE_NODE_MODULES ?? '/tmp/workflow-bootstrap.JpxCTM/node_modules');
for (const dep of ['vitest', 'typescript', '@electric-sql/pglite', '@usenaive-sdk/managed-agents', 'next', 'workflow']) if (!existsSync(join(deps, dep, 'package.json'))) throw new Error(`Missing existing offline dependency ${dep}: set BRIDGE_NODE_MODULES`);
const assembled = stageBridge();
const { stage } = assembled;
for (const relative of ['apps/web/src/server/workflow-data.ts','apps/web/src/server/data-production.ts','apps/web/src/server/rich-services.ts','apps/web/src/workflows/steps/rich-evaluation.ts','apps/web/migrations/003-workflow-data.sql','packages/core/src/evals/integration/services.ts']) {
  if (readFileSync(join(root,'docs/workflow-data-bridge/source',relative),'utf8') !== readFileSync(join(stage,relative),'utf8')) throw new Error(`Bridge patch/source mismatch: ${relative}`);
}
// Link the actual installed workspace dependencies with only @ae/core redirected to
// the applied source. No external SDK declarations or source substitutions.
mkdirSync(join(stage, 'node_modules'));
for (const entry of readdirSync(deps)) if (entry !== '@ae') symlinkSync(join(deps, entry), join(stage, 'node_modules', entry));
mkdirSync(join(stage, 'node_modules/@ae'));
symlinkSync(join(stage, 'packages/core'), join(stage, 'node_modules/@ae/core'), 'dir');
for (const sub of ['packages/core','apps/web']) {
  const local = join(deps, '..', sub, 'node_modules');
  if (!existsSync(local)) throw new Error(`Missing installed workspace dependency directory: ${local}`);
  symlinkSync(local, join(stage, sub, 'node_modules'), 'dir');
}
writeFileSync(join(stage, 'package.json'), '{"private":true,"type":"module"}');
const checks = join(stage, 'bridge-verification'); mkdirSync(checks);
for (const file of readdirSync(here).filter(f => f.endsWith('.test.ts'))) copyFileSync(join(here, file), join(checks, file));
copyFileSync(join(root, 'docs/workflow-integration/verification/costs.test.ts'), join(checks, 'global-costs.test.ts'));
copyFileSync(join(root, 'docs/data-production-integration/intake/source/data-production.test.ts'), join(stage, 'apps/web/src/server/data-production.test.ts'));
copyFileSync(join(root, 'docs/data-production-integration/intake/source/route.test.ts'), join(stage, 'apps/web/src/app/api/jobs/[jobId]/data-review/route.test.ts'));
copyFileSync(join(root, 'packages/core/src/evals/integration/approved-suite.test.ts'), join(stage, 'packages/core/src/evals/integration/approved-suite.test.ts'));
writeFileSync(join(checks, 'server-only.ts'), 'export {};\n');
const aliases = [
  {find: '@rich-step', replacement: join(stage,'apps/web/src/workflows/steps/rich-evaluation.ts')},
  {find: '@step-evaluate', replacement: join(stage,'apps/web/src/workflows/steps/evaluate.ts')},
  {find: '@step-common', replacement: join(stage,'apps/web/src/workflows/steps/common.ts')},
  {find: 'server-only', replacement: join(checks, 'server-only.ts')},
  {find: '@workflow-data', replacement: join(stage, 'apps/web/src/server/workflow-data.ts')},
  {find: '@costs', replacement: join(stage, 'apps/web/src/server/workflow-costs.ts')},
  {find: '@/', replacement: join(stage, 'apps/web/src/')},
];
const config = `export default {resolve:{alias:[...${JSON.stringify(aliases)},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage, 'packages/core/src/$1'))}}]},test:{include:['bridge-verification/*.test.ts','apps/web/src/server/data-production.test.ts','apps/web/src/app/api/jobs/**/data-review/route.test.ts','packages/core/src/evals/integration/approved-suite.test.ts'],maxWorkers:1}};`;
writeFileSync(join(stage, 'vitest.bridge.config.mjs'), config);
const resultFile = join(stage, 'bridge-results.json');
execFileSync(process.execPath, [join(deps, 'vitest/vitest.mjs'), 'run', '--config', 'vitest.bridge.config.mjs', '--reporter=default', '--reporter=json', `--outputFile.json=${resultFile}`], {cwd: stage, stdio: 'inherit', env: {...process.env, BRIDGE_STAGE: stage, BRIDGE_ROOT: root}});
const report = JSON.parse(readFileSync(resultFile, 'utf8'));
const cases = report.testResults.flatMap(file => file.assertionResults);
if (!cases.length || cases.some(test => test.status !== 'passed')) throw new Error('Missing, failed or skipped required tests');
// Transitive actual-source strict check of each changed runtime module, using real
// installed dependencies. Ambient declaration acknowledges server-only's marker only.
writeFileSync(join(stage, 'bridge-ambient.d.ts'), "declare module 'server-only';\n");
writeFileSync(join(stage, 'tsconfig.bridge.json'), JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,esModuleInterop:true,jsx:'react-jsx',resolveJsonModule:true,types:['node'],paths:{'@ae/core/*':[join(stage,'packages/core/src/*')],'@/*':[join(stage,'apps/web/src/*')]}},files:['bridge-ambient.d.ts','packages/core/src/evals/integration/approved-suite.ts','apps/web/src/server/data-production.ts','apps/web/src/server/workflow-data.ts','apps/web/src/server/rich-services.ts','apps/web/src/workflows/steps/rich-evaluation.ts']}, null, 2));
execFileSync(process.execPath, [join(deps, 'typescript/bin/tsc'), '-p', 'tsconfig.bridge.json'], {cwd: stage, stdio:'inherit'});
console.log(JSON.stringify({tests:cases.length,files:report.testResults.length,skipped:0,strictAppliedSourceTypecheck:'passed',...assembled}, null, 2));
