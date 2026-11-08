import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageAcceptance } from '../../../docs/app-acceptance-integration/stage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const installed = resolve(process.env.WORKFLOW_INSTALLED_WORKSPACE ?? '/tmp/workflow-bootstrap.JpxCTM');
const deps = join(installed, 'node_modules');
if (!existsSync(join(deps, 'vitest/vitest.mjs'))) throw new Error('Existing offline Vitest required; no install is attempted');
const { stage } = stageAcceptance();
mkdirSync(join(stage, 'node_modules/@ae'), { recursive: true });
for (const name of readdirSync(deps)) if (name !== '@ae') symlinkSync(join(deps, name), join(stage, 'node_modules', name));
symlinkSync(join(stage, 'packages/core'), join(stage, 'node_modules/@ae/core'), 'dir');
for (const sub of ['apps/web', 'packages/core']) symlinkSync(join(installed, sub, 'node_modules'), join(stage, sub, 'node_modules'), 'dir');
writeFileSync(join(stage, 'package.json'), '{"private":true,"type":"module"}\n');
const tests = join(stage, 'tests/track-b/app-acceptance-integration');
mkdirSync(dirname(tests), { recursive: true });
cpSync(here, tests, { recursive: true });
cpSync(join(root, 'docs/app-acceptance-integration'), join(stage, 'docs/app-acceptance-integration'), { recursive: true });
writeFileSync(join(tests, 'empty.ts'), 'export {};\n');
writeFileSync(join(stage, 'acceptance-ambient.d.ts'), "declare module 'server-only';\n");
writeFileSync(join(stage, 'tsconfig.acceptance.json'), JSON.stringify({ compilerOptions: {
  target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
  noEmit: true, skipLibCheck: true, esModuleInterop: true, jsx: 'react-jsx', resolveJsonModule: true,
  types: ['node'], paths: { '@ae/core/*': [join(stage, 'packages/core/src/*')], '@/*': [join(stage, 'apps/web/src/*')] },
}, files: ['acceptance-ambient.d.ts', 'docs/app-acceptance-integration/driver/rich-app.ts'] }, null, 2));
execFileSync(process.execPath, [join(deps, 'typescript/bin/tsc'), '-p', 'tsconfig.acceptance.json'], { cwd: stage, stdio: 'inherit' });
const aliases = [{ find: '@/', replacement: join(stage, 'apps/web/src/') },
  { find: 'server-only', replacement: join(tests, 'empty.ts') }];
writeFileSync(join(stage, 'vitest.acceptance.config.mjs'), `export default {resolve:{alias:[...${JSON.stringify(aliases)},{find:/^@ae\\/core\\/(.*)$/,replacement:${JSON.stringify(join(stage, 'packages/core/src/$1'))}}]},test:{include:['tests/track-b/app-acceptance-integration/adapter*.test.ts'],maxWorkers:1,minWorkers:1,fileParallelism:false,testTimeout:60000,hookTimeout:60000}};\n`);
console.log('Offline acceptance integration stage:', stage);
execFileSync(process.execPath, [join(deps, 'vitest/vitest.mjs'), 'run', '--config', 'vitest.acceptance.config.mjs'], {
  cwd: stage, stdio: 'inherit', env: { ...process.env, APP_ACCEPTANCE_STAGE: stage, APP_ACCEPTANCE_ROOT: root },
});
// Actual composed chat route + SQL authorization checks, with explicit offline
// sessions. This suite is serial and never supplies live acceptance evidence.
execFileSync(process.execPath, [join(root, 'tests/track-b/chat-release/security/run.mjs'), stage, deps], {
  cwd: root, stdio: 'inherit',
});
