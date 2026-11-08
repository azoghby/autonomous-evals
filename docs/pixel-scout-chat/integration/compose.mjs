import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { applyScout } from './apply.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--from' || args[2] !== '--out') {
  throw Error('Usage: compose.mjs --from verified-company-stage --out empty-directory');
}
const source = resolve(args[1]), out = resolve(args[3]);
if (source === out || out.startsWith(source + '/') || source.startsWith(out + '/')) throw Error('Separate output required');
if (existsSync(out) && readdirSync(out).length) throw Error('Output must be empty');
const inventoryBytes = readFileSync(join(root, 'docs/current-company-composition/CANDIDATE.json'));
const inventory = JSON.parse(inventoryBytes);
const pin = JSON.parse(readFileSync(join(root, 'docs/pixel-scout-chat/integration/PREIMAGES.json')));
if (inventory.parent !== pin.parent) throw Error('Parent mismatch');
const safe = p => typeof p === 'string' && !p.startsWith('/') && !p.split('/').some(s => !s || s === '.' || s === '..');
// Verify the complete input before writing any source. Never overlay newer A files.
for (const [path, entry] of Object.entries(inventory.files)) {
  if (!safe(path) || hash(readFileSync(join(source, path))) !== entry.sha256) throw Error('Company source drift: ' + path);
}
mkdirSync(out, { recursive: true });
for (const path of Object.keys(inventory.files)) {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), readFileSync(join(source, path)));
}
// This header is only the patch applicator's compatibility input, not an old
// inventory relabeled as current. SCOUT-COMPOSITION below owns final provenance.
writeFileSync(join(out, 'CURRENT-COMPOSITION.json'), JSON.stringify({ parent: inventory.parent, baseline: false, inventory: 'SCOUT-COMPOSITION.json' }, null, 2) + '\n');
applyScout(out);
const files = {};
for (const path of [...new Set([...Object.keys(inventory.files), ...Object.keys(pin.paths)])].sort()) {
  const bytes = readFileSync(join(out, path));
  const sha256 = hash(bytes);
  if (!Object.hasOwn(pin.paths, path) && sha256 !== inventory.files[path].sha256) throw Error('Unexpected source drift: ' + path);
  files[path] = { sha256, bytes: bytes.length };
}
const result = {
  parent: inventory.parent, stage: out, inputInventorySha256: hash(inventoryBytes),
  patchSha256: hash(readFileSync(join(root, 'docs/pixel-scout-chat/integration/owner.patch'))),
  explicitChanges: pin.paths, files,
  historicalManifests: 'Retained as historical inputs only; this inventory describes final source.',
  releaseAccepted: false, liveRunPerformed: false,
};
writeFileSync(join(out, 'SCOUT-COMPOSITION.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ stage: out, files: Object.keys(files).length, changedPaths: Object.keys(pin.paths), releaseAccepted: false }));
