#!/usr/bin/env node
// Offline verification only. Reads existing dependencies; never installs or runs a server.
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(directory, '../..');
const metadata = JSON.parse(await readFile(join(directory, 'PATCH.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireTrue = (ok, label) => { if (!ok) throw Error(label); };
const dependencies = process.env.ACCEPTANCE_DEPENDENCIES;
requireTrue(dependencies && dependencies.startsWith('/'), 'ACCEPTANCE_DEPENDENCIES must name an absolute existing node_modules directory');
const patch = join(directory, '0001-controlled-calendar-targets.patch');
requireTrue(digest(await readFile(patch)) === metadata.patchSha256, 'patch digest mismatch');
for (const [name, expected] of Object.entries(metadata.files)) {
  requireTrue(!name.includes('..') && name.startsWith('apps/web/src/app/api/internal/track-b-calendar/'), 'unexpected source path');
  requireTrue(digest(await readFile(join(directory, 'files', name))) === expected, 'source digest mismatch');
}
const staging = await mkdtemp(join(tmpdir(), 'controlled-acceptance-verification-'));
try {
  const source = join(staging, 'source');
  await mkdir(source);
  const archive = execFileSync('git', ['archive', metadata.trackA], { cwd: repository, maxBuffer: 128 * 1024 * 1024 });
  const archivePath = join(staging, 'base.tar');
  await writeFile(archivePath, archive);
  execFileSync('tar', ['-xf', archivePath, '-C', source]);
  execFileSync('git', ['apply', '--check', patch], { cwd: source });
  execFileSync('git', ['apply', patch], { cwd: source });
  for (const [name, expected] of Object.entries(metadata.files)) {
    requireTrue(digest(await readFile(join(source, name))) === expected, 'applied source mismatch');
  }
  // Verify that the patch introduces exactly the declared files and no other paths.
  const paths = execFileSync('git', ['apply', '--numstat', patch], { cwd: source, encoding: 'utf8' })
    .trim().split('\n').map(line => line.split('\t')[2]).sort();
  requireTrue(JSON.stringify(paths) === JSON.stringify(Object.keys(metadata.files).sort()), 'patch source manifest mismatch');
  execFileSync(process.execPath, [join(dependencies, 'typescript/bin/tsc'), '--noEmit', '--strict',
    '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM',
    '--typeRoots', join(dependencies, '@types'), '--types', 'node', '--skipLibCheck',
    ...Object.keys(metadata.files).map(name => join(source, name))], { cwd: source, stdio: 'inherit' });
  console.log(`Verified patch SHA256, all source hashes, exact clean application to ${metadata.trackA}, and strict route TypeScript compilation.`);
  console.log('Offline only; no dependency installation, provider calls, server, build, deployment, or secrets.');
} finally { await rm(staging, { recursive: true, force: true }); }
