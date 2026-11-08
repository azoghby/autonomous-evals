import { execFileSync as exec } from 'node:child_process';
import { cpSync, readFileSync as read, writeFileSync as write, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageCurrent, walk, sha } from '../current-autonomy-integration/stage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function candidate() {
  const prior = process.env.GIT_DIR;
  if (process.env.CALENDAR_ARCHIVE_GIT_DIR) process.env.GIT_DIR = process.env.CALENDAR_ARCHIVE_GIT_DIR;
  try { return stageCurrent().stage; }
  finally { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; }
}
const stage = candidate();
const paths = walk(join(here, 'source'));
exec('git', ['init', '-q'], { cwd: stage });
exec('git', ['add', '--', ...paths], { cwd: stage });
for (const path of paths) {
  mkdirSync(dirname(join(stage, path)), { recursive: true });
  cpSync(join(here, 'source', path), join(stage, path));
}
const patch = exec('git', ['diff', '--binary', '--no-ext-diff', '--', ...paths], { cwd: stage, maxBuffer: 16 * 1024 * 1024 });
write(join(here, 'calendar.patch'), patch);
const check = candidate();
exec('git', ['apply', '--check', join(here, 'calendar.patch')], { cwd: check });
exec('git', ['apply', join(here, 'calendar.patch')], { cwd: check });
for (const path of paths) {
  if (sha(read(join(check, path))) !== sha(read(join(here, 'source', path)))) throw new Error(`Postimage mismatch: ${path}`);
}
console.log(JSON.stringify({ stage: check, paths, patchSha256: sha(patch) }));
