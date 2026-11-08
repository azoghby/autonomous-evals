import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
export const artifacts = join(repo, 'docs/release-packaging-integration/packages');
export const manifest = JSON.parse(readFileSync(join(artifacts, 'manifest.json')));
export const show = (sha, file) => execFileSync('git', ['show', `${sha}:${file}`], { cwd: repo, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });

export function patchedFiles() {
  const lock = JSON.parse(show(manifest.trackA, 'package-lock.json'));
  const files = {};
  for (const [owner, additions] of Object.entries(manifest.dependencies)) {
    const pkg = JSON.parse(show(manifest.trackA, `${owner}/package.json`));
    for (const [name, version] of Object.entries(additions)) {
      if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) throw new Error(`Already declared: ${owner}/${name}`);
      if (lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Wrong locked version: ${name}`);
    }
    Object.assign(pkg.dependencies, additions);
    Object.assign(lock.packages[owner].dependencies, additions);
    files[`${owner}/package.json`] = JSON.stringify(pkg, null, 2) + '\n';
  }
  files['package-lock.json'] = JSON.stringify(lock, null, 2) + '\n';
  return files;
}

export function buildPatch() {
  const dir = mkdtempSync(join(tmpdir(), 'release-packaging-patch-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    const files = patchedFiles();
    for (const file of Object.keys(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), show(manifest.trackA, file));
    }
    execFileSync('git', ['add', '.'], { cwd: dir });
    for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
    return execFileSync('git', ['diff', '--no-ext-diff', '--no-color'], { cwd: dir, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(join(artifacts, 'track-a-manifests-lock.patch'), buildPatch());
}
