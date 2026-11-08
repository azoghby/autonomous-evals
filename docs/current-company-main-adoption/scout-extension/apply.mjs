import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'ORIGINAL-PREIMAGES.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');

/** Apply the additive Scout mark patch to an already composed (and writable) candidate. Refuses on any drift. */
export function applyScout(stage) {
  stage = resolve(stage);
  // Historical parent metadata is intentionally not rewritten: this explicit two-file
  // extension authenticates the unchanged reviewed chat preimage on the new composition.
  // The integrator authenticates the full 2df owner inventory before calling this helper.
  const patch = readFileSync(join(here, 'owner.patch'), 'utf8');
  const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]).sort();
  if (JSON.stringify(paths) !== JSON.stringify(Object.keys(manifest.paths).sort())) throw Error('Unexpected Scout patch paths');
  for (const [path, expected] of Object.entries(manifest.paths)) {
    const file = join(stage, path);
    if (expected.preimage === null ? existsSync(file) : hash(readFileSync(file)) !== expected.preimage) throw Error('Scout preimage drift: ' + path);
  }
  execFileSync('git', ['apply', '--check', join(here, 'owner.patch')], { cwd: stage });
  execFileSync('git', ['apply', join(here, 'owner.patch')], { cwd: stage });
  for (const [path, expected] of Object.entries(manifest.paths)) {
    if (hash(readFileSync(join(stage, path))) !== expected.sha256) throw Error('Scout result drift: ' + path);
  }
  return { stage, changes: manifest.paths };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node apply.mjs <composed-writable-stage>');
  console.log(JSON.stringify(applyScout(process.argv[2]), null, 2));
}
