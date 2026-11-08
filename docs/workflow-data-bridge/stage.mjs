import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSeries } from '../workflow-integration/stage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
export const parentPin = '48519bf16e04bce3397ceaeb8abea060d2636263';
export const dataPin = '66da7a4d408a6171994ce1af414d512733437a52';
const intakeHash = 'c2150e8e2fcecff69d19d323d120d8efeaab2e06b71d69ebce16d5614551f96b';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Offline archive/apply only. Never mutates a checkout, installs, or opens a provider. */
export function stageBridge({ applyBridge = true } = {}) {
  for (const line of readFileSync(join(root, 'docs/workflow-integration/SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [expected, relative] = line.split(/\s+/);
    if (!/^[a-f0-9]{64}$/.test(expected) || hash(join(root, relative)) !== expected) throw new Error(`Workflow pin bytes changed: ${relative}`);
  }
  const series = JSON.parse(readFileSync(join(root, 'docs/workflow-integration/SERIES.json'), 'utf8'));
  if (series.trackA !== 'f0068733ca49c37f40fd7de279325f21a4b5fbbb' || series.core !== '5906961c2a70c0d6d2999cf7086689402ff60f5b') throw new Error('Workflow commit pins changed');
  for (const ref of [parentPin, dataPin]) execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: root });
  const assembled = stageSeries();
  const { stage } = assembled;
  // Overlay only data prerequisites: never overwrite the verified Calendar/core or app patches.
  execFileSync('tar', ['-x', '-C', stage], { input: execFileSync('git', ['archive', parentPin, 'packages/core/src/evals/data'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }) });
  const intake = join(root, 'docs/data-production-integration/intake/track-a.patch');
  if (hash(intake) !== intakeHash) throw new Error('Data intake patch bytes changed');
  const service = readFileSync(join(stage, 'packages/core/src/integration/eval-services.ts'), 'utf8');
  for (const required of ['export async function buildAgentDeps()', 'NAIVE_BUDGET_PERIOD_ID', 'NAIVE_IDEMPOTENCY_NAMESPACE', 'directory: verified.directory', 'dryRun: true', 'version === undefined']) {
    if (!service.includes(required)) throw new Error(`Existing verified buildAgentDeps weakened: ${required}`);
  }
  // The sole excluded hunk exports buildAgentDeps. The earlier pinned service patch already
  // exports AND hardens it. Applying an unreviewed relaxed replacement is forbidden.
  if (!readFileSync(intake, 'utf8').startsWith('--- a/packages/core/src/integration/eval-services.ts\n+++ b/packages/core/src/integration/eval-services.ts\n@@ -94,4 +94,4 @@\n-async function buildAgentDeps(): Promise<TrackBServiceDeps> {\n+export async function buildAgentDeps(): Promise<TrackBServiceDeps> {\n')) throw new Error('Unexpected intake overlap');
  const intakeArgs = ['--exclude=packages/core/src/integration/eval-services.ts', intake];
  execFileSync('git', ['apply', '--check', ...intakeArgs], { cwd: stage });
  execFileSync('git', ['apply', ...intakeArgs], { cwd: stage });
  for (const [source, target] of [['data-production.ts', 'apps/web/src/server/data-production.ts'], ['route.ts', 'apps/web/src/app/api/jobs/[jobId]/data-review/route.ts']]) {
    if (readFileSync(join(root, 'docs/data-production-integration/intake/source', source), 'utf8') !== readFileSync(join(stage, target), 'utf8')) throw new Error('Intake applied source mismatch');
  }
  if (readFileSync(join(stage, 'packages/core/src/integration/eval-services.ts'), 'utf8') !== service) throw new Error('Intake overwrote verified buildAgentDeps');
  assembled.patches.push(intake);
  const admission = 'packages/core/src/evals/integration/approved-suite.ts';
  if (!existsSync(join(root, admission))) throw new Error('Authorized additive suite-admission module missing');
  copyFileSync(join(root, admission), join(stage, admission));
  if (applyBridge) {
    const patch = join(here, 'bridge.patch');
    if (!existsSync(patch)) throw new Error('Bridge patch missing');
    execFileSync('git', ['apply', '--check', patch], { cwd: stage });
    execFileSync('git', ['apply', patch], { cwd: stage });
    assembled.patches.push(patch);
  }
  return { ...assembled, parentPin, dataPin, dataOverlay: 'packages/core/src/evals/data', intake, intakeHash, excludedIntakeHunk: 'buildAgentDeps export already applied and hardened', admission, admissionHash: hash(join(root, admission)), ...(applyBridge ? {bridgeHash: hash(join(here, 'bridge.patch'))} : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(stageBridge({ applyBridge: !process.argv.includes('--before-bridge') })));
