import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'PREIMAGES.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');

/** Apply only the two pinned current UI files in an already composed candidate. */
export function applyMount(stage) {
  stage = resolve(stage);
  const composition = JSON.parse(readFileSync(join(stage, 'CURRENT-COMPOSITION.json'), 'utf8'));
  if (composition.parent !== manifest.parent || composition.baseline) throw Error('Mount requires the exact composed 0398517 candidate');
  const patch = readFileSync(join(here, 'owner.patch'), 'utf8');
  const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
  if (JSON.stringify(paths) !== JSON.stringify(Object.keys(manifest.paths))) throw Error('Unexpected mount patch paths');
  for (const [path, expected] of Object.entries(manifest.paths)) {
    if (hash(readFileSync(join(stage, path))) !== expected.preimage) throw Error('Mount preimage drift: ' + path);
  }
  execFileSync('git', ['apply', '--check', join(here, 'owner.patch')], { cwd: stage });
  execFileSync('git', ['apply', join(here, 'owner.patch')], { cwd: stage });
  for (const [path, expected] of Object.entries(manifest.paths)) {
    if (hash(readFileSync(join(stage, path))) !== expected.sha256) throw Error('Mount result drift: ' + path);
  }
  return { stage, parent: manifest.parent, changes: manifest.paths, chatClientMounted: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node apply.mjs <already-composed-stage>');
  console.log(JSON.stringify(applyMount(process.argv[2]), null, 2));
}
