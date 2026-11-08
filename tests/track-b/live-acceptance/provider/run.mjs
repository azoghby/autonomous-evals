#!/usr/bin/env node
import { readFile, open, stat } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { stageCore } from './stage-core.mjs';

export const SCENARIOS = ['S01', 'S09'];
export const CONFIG_NAMES = ['buggy.url', 'buggy.model', 'buggy.tokenRef', 'fixed.url', 'fixed.model', 'fixed.tokenRef', 'gateway.model', 'gateway.tokenRef', 'runId', 'evidenceFile'];
export function plan(artifact) {
  const suite = artifact.outcome.suite;
  const selected = suite.scenarios.filter(s => SCENARIOS.includes(s.id));
  if (suite.digest !== '0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9' || selected.length !== 2 || artifact.validationScope.measuredSessionMicroUsd !== 129924) throw Error('accepted_artifact_changed');
  return { scope: 'provider_text_only', acceptedDesignReused: true, scenarioIds: SCENARIOS, targetCalls: 4, gatewayCalls: selected.reduce((n,s) => n + s.rubricChecks.length, 0) * 2, maxTargetCompletionTokensPerCall: 512, maxGatewayCompletionTokensPerCall: 2048, retries: 0, naiveSessions: 0, cloudMutations: 0, costMicroUsd: null, monetaryCap: 'Provider billing remains unknown; parent must authorize the operation/token caps separately.' };
}
function required(ok, code) { if (!ok) throw Error(code); }
export async function secret(reference) {
  required(reference && typeof reference === 'object' && Object.keys(reference).length === 1, 'invalid_secret_reference');
  if (reference.env) { required(/^[A-Z][A-Z0-9_]*$/.test(reference.env), 'invalid_env_reference'); const value = process.env[reference.env]; required(value?.length && !/[\r\n]/.test(value), 'unavailable_env_reference'); return value; }
  required(typeof reference.file === 'string', 'invalid_file_reference');
  const metadata = await stat(reference.file);
  required(metadata.isFile() && metadata.size <= 16384 && (metadata.mode & 0o077) === 0, 'secret_file_must_be_private_bounded_regular_file');
  const value = (await readFile(reference.file, 'utf8')).trim();
  required(value.length && !/[\r\n]/.test(value), 'invalid_file_reference'); return value;
}
export async function main(argv = process.argv.slice(2)) {
  const artifact = JSON.parse(await readFile(new URL('../../../../packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json', import.meta.url), 'utf8'));
  const bounded = plan(artifact);
  if (argv.length === 1 && argv[0] === '--plan') { console.log(JSON.stringify({ ...bounded, requiredConfiguration: CONFIG_NAMES, liveRunPerformed: false }, null, 2)); return; }
  required(argv.length === 3 && argv[0] === '--live' && argv[1] === '--config', 'usage_requires_explicit_live_flag_and_private_config_or_plan');
  const configPath = resolve(argv[2]);
  const configStat = await stat(configPath);
  required(configStat.size <= 16384 && configStat.isFile() && (configStat.mode & 0o077) === 0, 'config_must_be_private_bounded_regular_file');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  required(/^[A-Za-z0-9_-]{1,48}$/.test(config.runId), 'invalid_run_id');
  required(typeof config.evidenceFile === 'string' && typeof config.gateway?.model === 'string' && config.gateway.model.trim(), 'missing_configuration');
  required(config.approvedTargetCalls === bounded.targetCalls && config.approvedGatewayCalls === bounded.gatewayCalls, 'explicit_operation_caps_required');
  // Secret resolution occurs only after the explicit live gate and approved caps.
  const tokens = {};
  for (const version of ['buggy', 'fixed']) {
    required(typeof config[version]?.url === 'string' && typeof config[version]?.model === 'string', 'missing_target_configuration');
    tokens[version] = await secret(config[version].tokenRef);
  }
  tokens.gateway = await secret(config.gateway.tokenRef);
  const evidence = await open(config.evidenceFile, 'wx', 0o600); // Never redispatch an existing/ambiguous run.
  const record = async value => { await evidence.write(`${JSON.stringify(value)}\n`); await evidence.sync(); };
  let staged;
  let targets = 0, judges = 0;
  try {
    staged = await stageCore(config.dependenciesDirectory ?? fileURLToPath(new URL('../../node_modules/', import.meta.url)));
    const load = relative => import(pathToFileURL(join(staged.root, 'src', relative)));
    const [{ createTextTarget }, { HttpsJsonTransport, targetUrl }, { createGatewayJudge }, { executeSuite, executionVerdict }, { evaluateObjectiveCheck }] = await Promise.all([
      load('targets/text.js'), load('targets/transport.js'), load('judges/gateway.js'), load('evals/text/execute.js'), load('evals/text/objective.js'),
    ]);
    for (const version of ['buggy','fixed']) targetUrl(config[version].url);
    await record({ kind: 'start', plan: bounded, runId: config.runId, scope: 'actual_provider_text', fallback: false });
    const authorized = new Set();
    const judge = createGatewayJudge({ model: config.gateway.model, token: async () => tokens.gateway,
      authorize: async operationId => { required(!authorized.has(operationId) && judges < bounded.gatewayCalls, 'judge_dispatch_denied'); authorized.add(operationId); judges++; await record({ kind: 'judge_intent', operationId }); },
      recordUsage: usage => { required(!Object.values(tokens).some(token => JSON.stringify(usage).includes(token)), 'credential_in_usage'); return record({ kind: 'judge_usage', usage }); },
    });
    const verdicts = {};
    for (const version of ['buggy', 'fixed']) {
      const transport = new HttpsJsonTransport({ timeoutMs: 30000 });
      const target = createTextTarget({ url: config[version].url, model: config[version].model, apiKey: tokens[version], maxCompletionTokens: 512 }, {
        post: async (...args) => { required(targets < bounded.targetCalls, 'target_dispatch_denied'); targets++; await record({ kind: 'target_intent', operationId: `${config.runId}:${version}:${targets}` }); return transport.post(...args); },
      });
      const result = await executeSuite(artifact.outcome.suite, `${config.runId}_${version}`, { target, judge, evaluateObjective: evaluateObjectiveCheck, knownSecrets: Object.values(tokens), concurrency: 1 }, { scenarioIds: SCENARIOS });
      verdicts[version] = result.executions.map(executionVerdict);
      // Raw prompts, provider responses, endpoints and credentials are never written by this harness.
      await record({ kind: 'text_result', version, suiteDigest: result.suiteDigest, verdicts: verdicts[version], checks: result.executions.map(e => ({ scenarioId: e.scenarioId, outcome: e.outcome, checks: e.checks.map(c => ({ checkId: c.checkId, kind: c.kind, status: c.status, reason: c.reason })) })) });
    }
    required(targets === bounded.targetCalls && judges === bounded.gatewayCalls, 'incomplete_dispatch_evidence');
    required(verdicts.buggy.includes('fail') && verdicts.fixed.every(v => v === 'pass'), 'known_buggy_fixed_expectations_not_met');
    await record({ kind: 'accepted', scope: 'actual_provider_text_only', targets, judges, costMicroUsd: null, appAcceptance: 'not_run' });
    console.log(JSON.stringify({ accepted: true, scope: 'actual_provider_text_only', targets, judges, costMicroUsd: null }));
  } catch { await record({ kind: 'failed_or_ambiguous', targets, judges, retry: 'operator_reconciliation_required' }); throw Error('live_acceptance_failed_or_ambiguous_consult_private_journal'); }
  finally { await evidence.close(); await staged?.cleanup(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Acceptance failed; configuration or private evidence requires operator review. No automatic retry.'); process.exitCode = 1; });
