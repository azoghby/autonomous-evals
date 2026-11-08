// Apply additions to an existing isolated composition, or archive exact Track A into a new directory.
import { readFileSync as read, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync as exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const dir = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(dir, '../..');
export function applyRemediation(stage) {
  stage = resolve(stage);
  const m = JSON.parse(read(resolve(dir, 'PATCH.json')));
  const hash = b => createHash('sha256').update(b).digest('hex');
  if (m.trackA !== '530af32067279497161c22ab00006247851d9200' || m.parent !== '40014f4cf0c08bc8c6986b4a40aa28a53695172c') throw Error('Pin drift');
  exec('git', ['cat-file', '-e', `${m.trackA}^{commit}`], { cwd: root });
  if (hash(read(resolve(root, m.artifact))) !== m.artifactSha256) throw Error('Frozen artifact changed');
  const patch = read(resolve(dir, '0001-controlled-remediation-targets.patch'));
  if (hash(patch) !== m.patchSha256) throw Error('Patch changed');
  for (const [path, digest] of Object.entries(m.files)) {
    if (!path.startsWith('apps/web/src/app/api/internal/track-b-remediation/') || hash(read(resolve(dir, 'files', path))) !== digest) throw Error('Source changed');
    if (existsSync(resolve(stage, path))) throw Error('Refuse overwrite');
  }
  exec('git', ['apply', '--check', '-'], { cwd: stage, input: patch });
  exec('git', ['apply', '-'], { cwd: stage, input: patch });
  for (const [path, digest] of Object.entries(m.files)) if (hash(read(resolve(stage, path))) !== digest) throw Error('Staged bytes differ');
  return { stage, trackA: m.trackA, files: m.files, liveRunPerformed: false };
}
export function stageRemediation(stage) {
  stage = resolve(stage);
  if (existsSync(stage)) throw Error('New empty destination required');
  const m = JSON.parse(read(resolve(dir, 'PATCH.json')));
  mkdirSync(stage, { recursive: true });
  exec('tar', ['-x', '-C', stage], { input: exec('git', ['archive', m.trackA], { cwd: root, maxBuffer: 128*1024*1024 }) });
  return applyRemediation(stage);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Destination required');
  console.log(JSON.stringify(stageRemediation(process.argv[2]), null, 2));
}
