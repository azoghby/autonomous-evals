#!/usr/bin/env node
// Offline maintainer operation: regenerate the additions-only patch and hash manifest.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative } from 'node:path';
const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(directory, '../..');
const trackA = 'da92bedd68b230188e2499fdd8440ea23b2f1d6b';
const parent = execFileSync('git', ['rev-parse', 'ad9b4f1^{commit}'], { cwd: repository, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = {};
let patch = '';
async function walk(path) {
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) { await walk(full); continue; }
    if (!entry.isFile()) throw Error('Unexpected source entry');
    const name = relative(join(directory, 'files'), full);
    if (!name.startsWith('apps/web/src/app/api/internal/track-b-calendar/') || !name.endsWith('.ts')) throw Error('Unexpected source path');
    const bytes = await readFile(full);
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n')) throw Error('Source must end in newline');
    files[name] = hash(bytes);
    const lines = text.slice(0,-1).split('\n');
    patch += `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`;
  }
}
await walk(join(directory, 'files'));
const manifest = await readFile(join(directory, 'files/apps/web/src/app/api/internal/track-b-calendar/manifest.ts'), 'utf8');
const pinned = name => { const match = manifest.match(new RegExp(`export const ${name} = '([a-f0-9]{64})'`)); if (!match) throw Error('Missing digest'); return match[1]; };
const fixture = await readFile(join(directory, 'files/apps/web/src/app/api/internal/track-b-calendar/fixture.ts'), 'utf8');
const systemPrompt = fixture.match(/export const SYSTEM = '([^']+)';/)?.[1];
if (!systemPrompt) throw Error('Missing exact system prompt');
const patchName = '0001-controlled-calendar-targets.patch';
await writeFile(join(directory, patchName), patch);
await writeFile(join(directory, 'PATCH.json'), JSON.stringify({ parent, trackA, patch: `docs/controlled-calendar-targets/${patchName}`, patchSha256: hash(patch), systemPrompt, systemPromptSha256: hash(systemPrompt), scenarioDigest: pinned('SCENARIO_DIGEST'), toolSchemaDigest: pinned('TOOL_SCHEMA_DIGEST'), files, origin: 'internal_fixture', liveRunPerformed: false, hostedHttpAcceptance: 'pending_owner_deployment', realGatewayAcceptance: 'pending', remotePromptAttestation: false }, null, 2) + '\n');
console.log('Regenerated additions-only patch and source digest manifest; application unchanged.');
