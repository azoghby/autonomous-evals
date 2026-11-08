import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim();

/** Offline test composition only: no checkout, migration, provider call or install. */
export function stageSeries() {
  const series = JSON.parse(readFileSync(join(here, 'SERIES.json'), 'utf8'));
  for (const ref of [series.trackA, series.core]) {
    if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('Immutable commit required');
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: repo });
  }
  const stage = mkdtempSync(join(tmpdir(), 'workflow-integration-'));
  function archive(ref, paths = []) {
    const data = execFileSync('git', ['archive', ref, ...paths], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', stage], { input: data });
  }
  const patches = [];
  function apply(relative) {
    if (!relative.startsWith('docs/') || relative.includes('..')) throw new Error('Unsafe patch path');
    const file = resolve(repo, relative);
    if (!existsSync(file)) throw new Error(`Required patch missing: ${relative}`);
    execFileSync('git', ['apply', '--check', file], { cwd: stage });
    execFileSync('git', ['apply', file], { cwd: stage });
    patches.push(file);
  }
  archive(series.trackA);
  for (const relative of series.beforeCorePatches) apply(relative);
  archive(series.core, series.coreOverlay);
  for (const relative of series.patches) apply(relative);
  return { stage, trackA: series.trackA, core: series.core, patches };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(stageSeries()));
}
