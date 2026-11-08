import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSeries } from '../workflow-integration/stage.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
/** Offline archive composition, never a Git checkout or migration deployment. */
export function stageRemediation({ apply = true } = {}) {
  const manifest = JSON.parse(readFileSync(join(here, 'SERIES.json'), 'utf8'));
  const result = stageSeries();
  // Preserve app, contracts, platform and integration edits from the pinned series;
  // replace only Track B's seven source directories with the immutable current base.
  const paths = JSON.parse(readFileSync(join(repo, 'docs/workflow-integration/SERIES.json'), 'utf8')).coreOverlay;
  const archive = execFileSync('git', ['archive', manifest.base, ...paths], { cwd: repo, maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', result.stage], { input: archive });
  // Reapply the prerequisite series' Calendar core hunks to the newer core.
  const producer = readFileSync(join(repo, 'docs/workflow-integration/workflow-producers/002-workflow-producers.patch'), 'utf8');
  const start = producer.indexOf('--- a/packages/core/src/evals/calendar-integration/index.ts');
  const calendar = producer.slice(start);
  if (/^\+\+\+ b\/(?!packages\/core\/)/m.test(calendar)) throw new Error('Unexpected app hunk after core boundary');
  if (start < 0) throw new Error('Missing pinned Calendar integration hunk');
  execFileSync('git', ['apply', '--check', '-'], { cwd: result.stage, input: calendar });
  execFileSync('git', ['apply', '-'], { cwd: result.stage, input: calendar });
  cpSync(join(repo, 'packages/core/src/evals/remediation/accounting'), join(result.stage, 'packages/core/src/evals/remediation/accounting'), { recursive: true });
  if (apply) for (const path of manifest.append) {
    const file = join(repo, path);
    execFileSync('git', ['apply', '--check', file], { cwd: result.stage });
    execFileSync('git', ['apply', file], { cwd: result.stage });
  }
  return { ...result, remediationBase: manifest.base, append: apply ? manifest.append : [] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(stageRemediation()));
