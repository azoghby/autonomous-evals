import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Current frozen12 includes two rubric checks per scenario, on both runs.
 * This preflight deliberately does not inspect runtime refs or import app code. */
export const OPERATION_PLAN = Object.freeze({ target: 77, gateway: 48, naive: 0, cloudMutation: 0, maxElapsedMs: 180000,
  reason: '24 Text executions + one confirmed reproduction + 48 full Calendar dispatches + four Calendar reproduction dispatches; 48 Text rubric judgments; retained proposal required' });
export function assertOperationPlan(limits) {
  for (const key of ['target', 'gateway', 'naive', 'cloudMutation']) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 0 || OPERATION_PLAN[key] > limits[key]) {
      throw new Error(`operation_plan_exceeds_approved_caps:${key}:${OPERATION_PLAN[key]}`);
    }
  }
  // The combined rich app currently supplies judge:null. Raising the cap alone cannot fix that.
  throw new Error('operation_plan_unexecutable:combined_rich_factory_has_no_rubric_judge');
}
export async function createAcceptanceDriver(options) {
  assertOperationPlan(options.limits);
  // Deliberately unreachable for the current app/caps; retains the concrete worker
  // wiring for owner integration without claiming a Text-only acceptance result.
  return { source: 'actual_app_provider', fallback: false, run: async () => {
    const { stage, phaseInput } = options.privateRuntimeRef;
    const modulePath = buildAppWorker(stage);
    const baseline = await runWorker({ modulePath, input: { ...phaseInput, phase: 'baseline' }, beforeDispatch: options.beforeDispatch, signal: options.signal });
    const restarted = await runWorker({ modulePath, input: { ...phaseInput, phase: 'restart' }, beforeDispatch: options.beforeDispatch, signal: options.signal });
    return { source: 'actual_app_facts_unaccepted', baseline, restarted };
  } };
}

export function buildAppWorker(stage) {
  const require = createRequire(join(stage, 'package.json'));
  const { buildSync } = require('esbuild');
  const modulePath = join(stage, 'app-acceptance-rich-worker.mjs');
  buildSync({ entryPoints: [fileURLToPath(new URL('./rich-app.ts', import.meta.url))], outfile: modulePath,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: {
      '@ae/core': join(stage, 'packages/core/src'), '@': join(stage, 'apps/web/src'),
      'server-only': join(stage, 'tests/track-b/app-acceptance-integration/empty.ts'),
    } });
  return modulePath;
}

/** Concrete worker protocol, separately exported for offline integration verification.
 * A compiled rich-app worker is an application artifact, never a callback returning flags.
 * IPC dispatch intents are acknowledged only after the parent meter durably records them. */
export function runWorker({ modulePath, input, beforeDispatch, signal }) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env }, signal,
    });
    let result;
    child.on('message', async message => {
      if (message.type === 'dispatch') {
        try { await beforeDispatch(message.intent); child.send({ type: 'ack', id: message.id }); }
        catch { child.kill(); reject(new Error('dispatch_denied')); }
      } else if (message.type === 'result') result = message.value;
      else if (message.type === 'failure') { child.kill(); reject(new Error('app_worker_failed')); }
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 && result !== undefined ? resolve(result) : reject(new Error('app_worker_failed')));
    child.send({ modulePath, input });
  });
}
