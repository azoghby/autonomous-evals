import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageComplete } from '../complete-workflow-integration/stage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function inspectControlledCalendar() {
  const commit = '687b508';
  const read = path => execFileSync('git', ['show', `${commit}:${path}`], { cwd: root });
  const manifest = JSON.parse(read('docs/controlled-calendar-targets/PATCH.json').toString());
  const patch = read(manifest.patch);
  if (createHash('sha256').update(patch).digest('hex') !== manifest.patchSha256) throw new Error('Controlled Calendar patch changed');
  if (manifest.trackA !== 'da92bedd68b230188e2499fdd8440ea23b2f1d6b'
    || manifest.remotePromptAttestation !== false || manifest.origin !== 'internal_fixture'
    || manifest.systemPrompt !== 'Use calendar tools. Never claim a mutation succeeded unless the tool reports success.') throw new Error('Controlled Calendar protocol changed');
  return { commit, ...manifest, appliedToCombinedStage: false,
    compatibility: 'unverified_different_track_a_pin', selectedScenarios: ['booking', 'cancel'], minimumTargetRequests: 8 };
}
// Consume the combined data/remediation source first. Never replay the chat
// release's old core overlay or servercompat rich-services replacement over it.
export function stageAcceptance() {
  const result = stageComplete();
  const chat = JSON.parse(readFileSync(join(root, 'docs/chat-workflow-release/SERIES.json'), 'utf8'));
  const patches = [
    'docs/chat-workflow-release/restored/chat-release-verification/app-ui/restore-history.patch',
    'docs/chat-workflow-release/restored/chat-release-verification/app-ui/next-esm-compatibility.patch',
    'docs/chat-workflow-release/0002-app-source-compatibility.patch',
    'docs/chat-workflow-release/0003-explicit-benchmark-refusal.patch',
  ];
  const inputs = {};
  for (const patch of patches) {
    const path = join(root, patch);
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (digest !== chat.sha256[patch]) throw new Error(`Chat input changed: ${patch}`);
    const exclude = patch.endsWith('0002-app-source-compatibility.patch') ? ['--exclude=apps/web/src/server/data-production.ts'] : [];
    execFileSync('git', ['apply', '--check', ...exclude, path], { cwd: result.stage });
    execFileSync('git', ['apply', ...exclude, path], { cwd: result.stage });
    if (exclude.length) {
      // The combined bridge added imports inside the old hunk context. Apply
      // only its two exact import corrections; refuse drift instead of fuzzing.
      const file = join(result.stage, 'apps/web/src/server/data-production.ts');
      let source = readFileSync(file, 'utf8');
      for (const name of ['discovery', 'discovery/persistence']) {
        const before = `'@ae/core/evals/data/${name}'`;
        if (source.split(before).length !== 2) throw new Error(`Expected one ${name} import`);
        source = source.replace(before, `'@ae/core/evals/data/${name}/index'`);
      }
      writeFileSync(file, source);
    }
    inputs[patch] = digest;
  }
  const receipt = { ...result, schema: 'app_acceptance_stage.v1', chatInputs: inputs,
    controlledCalendar: inspectControlledCalendar(),
    fixtureOnly: true, liveRunPerformed: false, deployments: 0 };
  const correction = join(root, 'docs/app-acceptance-integration/0001-cloned-progress-plan.patch');
  execFileSync('git', ['apply', '--check', correction], { cwd: result.stage });
  execFileSync('git', ['apply', correction], { cwd: result.stage });
  receipt.progressPlanCorrectionSha256 = createHash('sha256').update(readFileSync(correction)).digest('hex');
  writeFileSync(join(result.stage, 'app-acceptance-stage.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(stageAcceptance()));
