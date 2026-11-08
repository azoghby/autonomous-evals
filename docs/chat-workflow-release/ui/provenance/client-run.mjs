import { mkdtempSync, cpSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const dependencies = resolve(process.env.CHAT_UI_NODE_MODULES ?? '/tmp/progress-chat-ui-verification/node_modules');
const stage = mkdtempSync(join(tmpdir(), 'progress-chat-client-'));
cpSync(here, stage, { recursive: true });
const component = process.env.CHAT_STAGE_DIR ? join(resolve(process.env.CHAT_STAGE_DIR), 'apps/web/src/components/app/job-private-chat.tsx') : join(here, '../source/job-private-chat.tsx');
cpSync(component, join(stage, 'job-private-chat.tsx'));
symlinkSync(dependencies, join(stage, 'node_modules'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({private:true,type:'module'}));
for (const [tool, args] of [['tsc', ['--noEmit', '-p', 'tsconfig.json']], ['vitest', ['run', '--config', 'vitest.config.ts']]]) {
  const result = spawnSync(join(dependencies, '.bin', tool), args, {cwd: stage, stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Client fixtures and targeted typecheck passed in ${stage}`);
