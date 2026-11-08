// Tests an existing stage unchanged; no patch application or Git metadata reads.
import {mkdtempSync,cpSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
if(!process.argv[2])throw Error('Usage: node hook-existing.mjs STAGE');
const here=dirname(fileURLToPath(import.meta.url)),stage=resolve(process.argv[2]),scratch=mkdtempSync('/tmp/chat-hook-existing-');
const deps=process.env.CHAT_UI_NODE_MODULES??'/tmp/progress-chat-ui-verification/node_modules';
const source=readFileSync(join(stage,'apps/web/src/lib/client/use-live-job.ts'));
cpSync(join(here,'hook.test.tsx'),join(scratch,'hook.test.tsx'));writeFileSync(join(scratch,'use-live-job.ts'),source);
writeFileSync(join(scratch,'api.ts'),'export function api(){throw Error("unmocked fixture api")}');
writeFileSync(join(scratch,'live-connection.ts'),'export function connectLive(){throw Error("unmocked fixture transport")}');
writeFileSync(join(scratch,'package.json'),'{"type":"module"}');symlinkSync(deps,join(scratch,'node_modules'));
writeFileSync(join(scratch,'vitest.config.mjs'),`export default {esbuild:{jsx:'automatic'},test:{environment:'jsdom',include:['hook.test.tsx'],maxWorkers:1,minWorkers:1}}`);
console.log(JSON.stringify({stage,sourceSha256:createHash('sha256').update(source).digest('hex')}));
const r=spawnSync(process.execPath,[join(deps,'vitest/vitest.mjs'),'run','--config','vitest.config.mjs'],{cwd:scratch,stdio:'inherit'});process.exitCode=r.status??1;
