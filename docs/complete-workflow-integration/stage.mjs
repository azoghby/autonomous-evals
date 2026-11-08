import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageBridge } from '../workflow-data-bridge/stage.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
export const base = 'ec123e9ebf1e83c27f8109102658d1554cb20fb5';
export const core = 'e61ad9719a1f7cfc844523cffbd72253dcdcb30b';
export const overlaps = ['apps/web/src/server/rich-services.ts','apps/web/src/workflows/steps/rich-evaluation.ts'];
export function stageComplete({ applyMerge = true } = {}) {
  const manifest = JSON.parse(readFileSync(join(here, 'SERIES.json'), 'utf8'));
  if (manifest.base !== base || manifest.core !== core) throw new Error('Composition pins changed');
  for (const [path, expected] of Object.entries(manifest.sha256)) {
    const actual = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    if (actual !== expected) throw new Error(`Composition input changed: ${path}`);
  }
  const result = stageBridge();
  const paths = ['agents','evals','judges','monitoring','reporting','simulator','targets'].map(p => `packages/core/src/${p}`);
  // Remove the seven old trees first: extraction alone could retain deleted old files.
  for (const path of paths) rmSync(join(result.stage,path), {recursive:true,force:true});
  execFileSync('tar', ['-x','-C',result.stage], {input:execFileSync('git',['archive',core,...paths],{cwd:root,maxBuffer:128*1024*1024})});
  const remediation = join(root,'docs/workflow-remediation-integration/app/003-remediation.patch');
  const exclusions = overlaps.map(p => `--exclude=${p}`);
  for (const args of [['--check',...exclusions,remediation],[...exclusions,remediation]]) execFileSync('git',['apply',...args],{cwd:result.stage});
  if (applyMerge) {
    const patch = join(here,'combined.patch');
    execFileSync('git',['apply','--check',patch],{cwd:result.stage});
    execFileSync('git',['apply',patch],{cwd:result.stage});
    for (const p of overlaps) if (!readFileSync(join(result.stage,p)).equals(readFileSync(join(here,'source',p)))) throw new Error(`Merged source mismatch: ${p}`);
  }
  return {...result, base, core, remediation, excluded:overlaps, combined:applyMerge};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(stageComplete()));
