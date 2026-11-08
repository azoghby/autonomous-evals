// Offline maintainer regeneration; no application mutation.
import { readFileSync as read, writeFileSync as write } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const dir = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(dir, '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['apps/web/src/app/api/internal/track-b-remediation/fixture.ts', 'apps/web/src/app/api/internal/track-b-remediation/chat/completions/route.ts'];
const artifact = 'packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json';
const suite = JSON.parse(read(resolve(root, artifact))).outcome.suite;
const files = {};
let patch = '';
for (const path of paths) {
  const bytes = read(resolve(dir, 'files', path)); files[path] = sha(bytes);
  const text = bytes.toString('utf8'); if (!text.endsWith('\n')) throw Error('Missing newline');
  const lines = text.slice(0,-1).split('\n');
  patch += `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => '+'+l).join('\n')}\n`;
}
write(resolve(dir, '0001-controlled-remediation-targets.patch'), patch);
write(resolve(dir, 'PATCH.json'), JSON.stringify({ parent: '40014f4cf0c08bc8c6986b4a40aa28a53695172c', trackA: '530af32067279497161c22ab00006247851d9200', patchSha256: sha(patch), files, artifact, artifactSha256: sha(read(resolve(root, artifact))), suiteDigest: suite.digest, baselineSystem: suite.systemPrompt, baselineSystemSha256: sha(suite.systemPrompt), origin: 'internal_fixture', liveRunPerformed: false, remoteAttestation: false }, null, 2)+'\n');
