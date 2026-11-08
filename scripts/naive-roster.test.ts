import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, stat, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPANY_ROLE_DEFINITIONS, type CompanyRole } from '../packages/core/src/agents/company-roles';
import { readPrivateRosterJson, runRosterCli } from './naive-roster';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'roster-cli-')); dirs.push(dir);
  const roles = Object.keys(COMPANY_ROLE_DEFINITIONS) as CompanyRole[];
  const spec = { schemaVersion: 'naive_roster_rollout.v1', createRevisionAgents: true, revision: 'pilot', model: 'explicit-model', appOrigin: 'https://example.com', internalMcpUrl: 'https://example.com/api/mcp/internal/mcp', onIdleUrl: 'https://example.com/api/naive/idle/private_test_token', credentialFiles: Object.fromEntries(roles.filter(r => Object.keys(COMPANY_ROLE_DEFINITIONS[r].tools).some(t => t.startsWith('se_internal.'))).map(r => [r, `/nonexistent-private-bearers/${r}`])), schedules: Object.fromEntries(roles.filter(r => COMPANY_ROLE_DEFINITIONS[r].deployment).map(r => [r, { cron: '0 7 * * *', timezone: 'UTC', inputTemplate: 'Review bounded work' }])) };
  const input = join(dir, 'spec.json'); await writeFile(input, JSON.stringify(spec), { mode: 0o600 }); return { dir, input, spec };
}
it('writes a private complete options/plan pair without reading referenced bearer files', async () => {
  const f = await fixture(), output = join(f.dir, 'stage');
  expect(await runRosterCli(['--next', f.input, output])).toMatchObject({ stage: 'resources', operations: 14, applyReady: false });
  expect((await stat(output)).mode & 0o777).toBe(0o700);
  for (const name of ['options.json', 'plan.json']) expect((await stat(join(output, name))).mode & 0o777).toBe(0o600);
  const options = JSON.parse(await readFile(join(output, 'options.json'), 'utf8')), plan = JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'));
  expect(options.stage).toBe('resources'); expect(plan.operations).toHaveLength(14);
  await expect(runRosterCli(['--next', f.input, output])).rejects.toThrow();
  expect(JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'))).toEqual(plan);
});
it('rejects symlinks, shared input permissions, oversized files and non-regular descriptors', async () => {
  const f = await fixture(), alias = join(f.dir, 'alias'); await symlink(f.input, alias);
  await expect(readPrivateRosterJson(alias)).rejects.toThrow();
  await chmod(f.input, 0o644); await expect(readPrivateRosterJson(f.input)).rejects.toThrow();
  await chmod(f.input, 0o600); await writeFile(f.input, ' '.repeat(2_000_001)); await expect(readPrivateRosterJson(f.input)).rejects.toThrow();
  await expect(readPrivateRosterJson(f.dir)).rejects.toThrow();
  const fifo = join(f.dir, 'pipe'); const made = spawnSync('mkfifo', ['-m', '600', fifo]); expect(made.status).toBe(0);
  await expect(readPrivateRosterJson(fifo)).rejects.toThrow();
});
it('validates all evidence before writing and never writes dotenv output', async () => {
  const f = await fixture(), output = join(f.dir, 'stage');
  const receipt = join(f.dir, 'receipt.json'); await writeFile(receipt, '{}', { mode: 0o600 });
  await expect(runRosterCli(['--next', f.input, output, receipt])).rejects.toThrow();
  await expect(stat(output)).rejects.toThrow();
  await expect(runRosterCli(['--next', f.input, join(f.dir, '.env.local')])).rejects.toThrow();
  await expect(stat(join(f.dir, '.env.local'))).rejects.toThrow();
});
it('executable CLI is offline and prints only a safe summary or static failure', async () => {
  const f = await fixture(); const args = [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/naive-roster.ts')];
  const env = { PATH: process.env.PATH, NAIVE_API_KEY_FILE: '/nonexistent-provider-key' };
  const good = spawnSync(process.execPath, [...args, '--next', f.input, join(f.dir, 'stage')], { encoding: 'utf8', env, timeout: 15_000 });
  expect(good.status).toBe(0); expect(JSON.parse(good.stdout)).toMatchObject({ mode: 'offline_stage_plan', applyReady: false });
  expect(good.stdout + good.stderr).not.toMatch(/private_test_token|nonexistent-private|nonexistent-provider/);
  await writeFile(f.input, JSON.stringify({ ...f.spec, model: 'private_test_token', forbidden: 'never-log-this' }));
  const bad = spawnSync(process.execPath, [...args, '--next', f.input, join(f.dir, 'bad')], { encoding: 'utf8', env, timeout: 15_000 });
  expect(bad.status).toBe(1); expect(bad.stdout).toBe(''); expect(bad.stderr).toContain('Roster handoff blocked'); expect(bad.stderr).not.toMatch(/private_test_token|never-log-this/);
});
