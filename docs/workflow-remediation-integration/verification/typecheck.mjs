import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, unlinkSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const stage = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node typecheck.mjs ASSEMBLED_STAGE');
const installed = resolve(process.env.WORKFLOW_INSTALLED_WORKSPACE ?? '/tmp/workflow-bootstrap.JpxCTM');
// Resolve actual installed app dependencies and local staged core package exports.
for (const sub of ['packages/core', 'apps/web']) {
  const target = join(stage, sub, 'node_modules');
  if (!existsSync(target)) symlinkSync(join(installed, sub, 'node_modules'), target, 'dir');
}
const deps = join(installed, 'node_modules');
if (existsSync(join(stage, 'node_modules')) && lstatSync(join(stage, 'node_modules')).isSymbolicLink()) unlinkSync(join(stage, 'node_modules'));
if (!existsSync(join(stage, 'node_modules'))) {
  mkdirSync(join(stage, 'node_modules/@ae'), { recursive: true });
  for (const item of readdirSync(deps)) if (item !== '@ae') symlinkSync(join(deps, item), join(stage, 'node_modules', item));
  symlinkSync(join(stage, 'packages/core'), join(stage, 'node_modules/@ae/core'), 'dir');
}
writeFileSync(join(stage, 'remediation-offline.d.ts'), "declare module 'server-only';\n");
writeFileSync(join(stage, 'tsconfig.remediation.json'), JSON.stringify({ compilerOptions: {
 target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,
 esModuleInterop:true,resolveJsonModule:true,types:['node'],paths:{'@ae/core/*':[join(stage,'packages/core/src/*')],'@/*':[join(stage,'apps/web/src/*')]},
}, include:['remediation-offline.d.ts','packages/core/src/evals/remediation/accounting/index.ts','apps/web/src/server/rich-remediation.ts','apps/web/src/server/rich-services.ts','apps/web/src/workflows/steps/rich-evaluation.ts','apps/web/src/app/api/operator/jobs/[jobId]/workflow-binding/route.ts'] }, null, 2));
execFileSync(process.execPath, [join(deps, 'typescript/bin/tsc'), '-p', 'tsconfig.remediation.json'], { cwd: stage, stdio:'inherit' });
console.log('Strict new accounting and applied remediation app/Workflow entrypoint typecheck passed (transitive source included; server-only marker declared).');
