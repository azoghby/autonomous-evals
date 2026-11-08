import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageCore } from '../live-acceptance/provider/stage-core.mjs';

// Read-only existence/scope check, not SQL connectivity or migration acceptance.
export async function verifyBranches(api, { projectId, mainBranchId, seedBranchId }) {
  if (!/^[a-z0-9-]{1,60}$/.test(projectId ?? '') ||
      ![mainBranchId, seedBranchId].every(id => /^br-[a-z0-9-]{1,60}$/.test(id ?? '')) ||
      mainBranchId === seedBranchId) throw Error('invalid_branch_configuration');
  const checks = [];
  for (const [role, id] of [['main', mainBranchId], ['seed', seedBranchId]]) {
    const response = await api.call('GET', `/projects/${projectId}/branches/${id}`);
    if (response.status === 404) { checks.push({ role, status: 'not_found_or_not_visible' }); continue; }
    if (response.status !== 200) throw Error('branch_read_failed');
    const branch = response.body?.branch;
    if (!branch || branch.id !== id || branch.project_id !== projectId || typeof branch.default !== 'boolean') throw Error('branch_identity_mismatch');
    checks.push({ role, status: 'exists_in_project', isDefault: branch.default });
  }
  return { readOnly: true, accepted: checks.every(c => c.status === 'exists_in_project'), checks,
    sqlConnectivity: 'not_checked', seedSchema: 'not_checked', deploymentConfiguration: 'not_checked' };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify({ requests: 2, method: 'GET', mutations: 0, required: ['private config with projectId, mainBranchId, seedBranchId, keyFile'], liveRunPerformed: false }));
    return;
  }
  if (args.length !== 3 || args[0] !== '--read-only' || args[1] !== '--config') throw Error('explicit_read_only_config_required');
  const configFile = resolve(args[2]);
  const meta = await stat(configFile);
  if (!meta.isFile() || meta.size > 16384 || (meta.mode & 0o077)) throw Error('private_config_required');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  // Validate all nonsecret inputs before opening the private key.
  await verifyBranches({ call: async () => ({ status: 404 }) }, config);
  const keyMeta = await stat(config.keyFile);
  if (!keyMeta.isFile() || keyMeta.size > 4096 || (keyMeta.mode & 0o077)) throw Error('private_key_file_required');
  const key = (await readFile(config.keyFile, 'utf8')).trim();
  if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw Error('invalid_key');
  const staged = await stageCore(resolve('tests/track-b/node_modules'));
  try {
    const { NeonHttpApi } = await import(pathToFileURL(join(staged.root, 'src/simulator/neon.js')));
    const result = await verifyBranches(new NeonHttpApi(key), config);
    console.log(JSON.stringify(result));
    if (!result.accepted) process.exitCode = 1;
  } finally { await staged.cleanup(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Neon read-only verification failed; no provider body or credential is displayed.'); process.exitCode = 1; });
}
