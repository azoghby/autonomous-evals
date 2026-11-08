// Applies the Scout owner patch to a COPY of a read-only composed candidate, then runs the existing
// current-chat-mount UI suites unmodified plus the new pixel-scout suite, with strict types.
// Usage: node tests/track-b/pixel-scout-chat/run.mjs <composed-candidate> [evidence-dir]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyScout } from '../../../docs/pixel-scout-chat/integration/apply.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
if (!process.argv[2]) throw Error('Usage: node tests/track-b/pixel-scout-chat/run.mjs <composed-candidate> [evidence-dir]');
const candidate = resolve(process.argv[2]);
const deps = resolve(process.env.CHAT_UI_NODE_MODULES ?? '/tmp/progress-chat-ui-verification/node_modules');
if (!existsSync(join(deps, '.bin/vitest'))) throw Error('Existing offline React/jsdom dependencies unavailable; set CHAT_UI_NODE_MODULES. No install performed.');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// 1. Copy only the files the patch touches; the candidate itself is never written.
const stage = mkdtempSync(join(tmpdir(), 'pixel-scout-stage-'));
const chat = 'apps/web/src/components/app/job-private-chat.tsx';
mkdirSync(dirname(join(stage, chat)), { recursive: true });
cpSync(join(candidate, 'CURRENT-COMPOSITION.json'), join(stage, 'CURRENT-COMPOSITION.json'));
cpSync(join(candidate, chat), join(stage, chat));
const applied = applyScout(stage);

// 2. Suite: patched chat + scout-mark + the existing suites byte-for-byte + the new suite.
const mountUi = join(root, 'tests/track-b/current-chat-mount/ui');
const suite = mkdtempSync(join(tmpdir(), 'pixel-scout-ui-'));
cpSync(join(stage, chat), join(suite, 'job-private-chat.tsx'));
cpSync(join(stage, 'apps/web/src/components/app/scout-mark.tsx'), join(suite, 'scout-mark.tsx'));
cpSync(join(root, 'assets/brand/scout-pixel.svg'), join(suite, 'scout-pixel.svg'));
cpSync(join(here, 'pixel-scout.test.tsx'), join(suite, 'pixel-scout.test.tsx'));
const existing = ['interactions.test.tsx', 'job-bindings.test.tsx', 'mount-fixture.tsx', 'chat.test.tsx', 'reauth.test.tsx', 'privacy.test.tsx', 'hook.test.tsx'];
for (const name of existing) cpSync(join(mountUi, name), join(suite, name));
cpSync(join(candidate, 'apps/web/src/components/app/job-view.tsx'), join(suite, 'job-view.tsx'));
cpSync(join(candidate, 'apps/web/src/lib/client/use-live-job.ts'), join(suite, 'use-live-job.ts'));
writeFileSync(join(suite, 'api.ts'), 'export function api<T>(...args:unknown[]):Promise<T>{throw Error("fixture must mock api")}');
writeFileSync(join(suite, 'live-connection.ts'), 'export function connectLive(...args:unknown[]):()=>void{throw Error("fixture must mock live")}');
symlinkSync(deps, join(suite, 'node_modules'), 'dir');
writeFileSync(join(suite, 'package.json'), '{"private":true,"type":"module"}');
writeFileSync(join(suite, 'vitest.config.ts'), `import {resolve} from 'node:path';export default {plugins:[{name:'mount-boundary-fixtures',enforce:'pre',resolveId(id,importer){if(importer?.endsWith('/job-view.tsx')&&id!=='react'&&!id.startsWith('react/')&&id!=='./job-private-chat')return resolve('mount-fixture.tsx');}}],esbuild:{jsx:'automatic'},test:{environment:'jsdom',include:['*.test.tsx'],maxWorkers:1,minWorkers:1}};`);
writeFileSync(join(suite, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, lib: ['ES2023', 'DOM'], types: ['node', 'react'] }, include: ['interactions.test.tsx', 'pixel-scout.test.tsx', 'job-private-chat.tsx', 'scout-mark.tsx'] }));

const result = { candidate, stage, suite, applied: applied.changes, chatSha256: sha(join(suite, 'job-private-chat.tsx')), scoutMarkSha256: sha(join(suite, 'scout-mark.tsx')), svgSha256: sha(join(root, 'assets/brand/scout-pixel.svg')), react: JSON.parse(readFileSync(join(deps, 'react/package.json'))).version, boundary: 'Offline React/jsdom with the patched chat component rendered; JobView dependencies stubbed as in current-chat-mount. No browser, screenshot, pixel layout, hosted auth, provider or deployment verification.', checks: {} };
let failed = false;
const evidence = process.argv[3] ? resolve(process.argv[3]) : null;
if (evidence) mkdirSync(evidence, { recursive: true });
for (const [name, bin, args] of [['types', 'tsc', ['--noEmit', '-p', 'tsconfig.json']], ['suites', 'vitest', ['run', '--config', 'vitest.config.ts']]]) {
  const r = spawnSync(join(deps, '.bin', bin), args, { cwd: suite, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: '1' } });
  result.checks[name] = { exit: r.status };
  failed ||= r.status !== 0;
  const log = (r.stdout ?? '') + (r.stderr ?? '');
  if (evidence) writeFileSync(join(evidence, name + '.log'), log);
  console.log(log);
}
if (evidence) writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (failed) process.exitCode = 1;
