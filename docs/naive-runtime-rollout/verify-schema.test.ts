import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { applyProfile, readPlan, verifyPlan, type SchemaPlan } from './verify-schema';

const root = resolve(import.meta.dirname, '../..');
const copy = (): SchemaPlan => structuredClone(readPlan(root));
describe('offline runtime schema plan', () => {
  it('checks every canonical/alias/evidence hash and complete ordered dependency graph', () => {
    const checked = verifyPlan(root);
    expect(checked.sql.size).toBe(checked.plan.baseMigrations.length + checked.plan.sidecars.length);
  });
  for (const profile of ['application', 'optionalApplication', 'simulator']) {
    it(`applies ${profile} without SQL rewrites, retries, or ignored errors in fresh in-memory PGlite`, async () => {
      const checked = verifyPlan(root);
      const result = await applyProfile(checked, profile);
      expect(result.applied).toEqual(checked.plan.profiles[profile]);
      expect(result.liveActions).toBe(false);
    });
  }
  it('rejects a changed SQL hash', () => {
    const plan = copy(); plan.baseMigrations[0].sha256 = '0'.repeat(64);
    expect(() => verifyPlan(root, plan)).toThrow(/SHA-256 mismatch/);
  });
  it('rejects alias mismatches', () => {
    const plan = copy();
    const migration = [...plan.baseMigrations, ...plan.sidecars].find(entry => entry.aliases.length)!;
    expect(migration).toBeDefined(); migration.aliases[0].sha256 = '0'.repeat(64);
    expect(() => verifyPlan(root, plan)).toThrow(/Alias content differs/);
  });
  it('rejects cycles, missing dependencies, and duplicate application', () => {
    const cyclic = copy(); cyclic.baseMigrations[0].dependsOn.push(cyclic.baseMigrations.at(-1)!.id);
    expect(() => verifyPlan(root, cyclic)).toThrow(/Dependency cycle/);
    const missing = copy(); missing.sidecars[0].dependsOn.push('missing');
    expect(() => verifyPlan(root, missing)).toThrow(/Unknown dependency/);
    const replay = copy(); replay.profiles.application.push(replay.profiles.application[0]);
    expect(() => verifyPlan(root, replay)).toThrow(/Migration replay/);
  });
  it('rejects incomplete canonical order and base inventory', () => {
    const plan = copy(); plan.canonicalOrder.pop();
    expect(() => verifyPlan(root, plan)).toThrow(/omits migrations/);
    const base = copy(); base.baseMigrations.reverse();
    expect(() => verifyPlan(root, base)).toThrow(/Base migrations differ/);
  });
  it('rejects out-of-order profiles and alias execution as an additional canonical entry', () => {
    const plan = copy();
    plan.profiles.application.reverse();
    expect(() => verifyPlan(root, plan)).toThrow(/dependency|base migrations/);
    const duplicate = copy();
    const aliased = duplicate.sidecars.find(entry => entry.aliases.length) ?? duplicate.baseMigrations.find(entry => entry.aliases.length)!;
    duplicate.sidecars.push({ ...aliased, ...aliased.aliases[0], id: 'bad-alias-replay', aliases: [] });
    expect(() => verifyPlan(root, duplicate)).toThrow(/Duplicate canonical|Repeated alias/);
  });
  it('stops on a failing migration and does not execute later migrations', async () => {
    const checked = verifyPlan(root);
    const first = checked.plan.profiles.simulator[0];
    checked.sql.set(first, 'SELECT nonexistent_schema.nonexistent_function();');
    await expect(applyProfile(checked, 'simulator')).rejects.toThrow(`Migration failed (simulator, ${first}); stopped after 0`);
  });
  it('surfaces a non-idempotent migration replay rather than swallowing its SQL error', async () => {
    const checked = verifyPlan(root);
    const first = checked.plan.profiles.simulator[0];
    checked.plan.profiles.simulator = [first, first];
    checked.sql.set(first, 'CREATE TABLE replay_must_fail(id integer);');
    await expect(applyProfile(checked, 'simulator')).rejects.toThrow(/stopped after 1:.*already exists/);
  });
});

it('rejects omitted inventory entries and cross-database profiles', () => {
  const omitted = copy();
  const removed = omitted.sidecars.find(entry => entry.id === 'calendar')!;
  omitted.sidecars = omitted.sidecars.filter(entry => entry.id !== removed.id);
  omitted.canonicalOrder = omitted.canonicalOrder.filter(id => id !== removed.id);
  omitted.profiles.simulator = [...omitted.profiles.application];
  expect(() => verifyPlan(root, omitted)).toThrow(/inventory coverage/);
  const crossed = copy(); crossed.profiles.application.push('calendar');
  expect(() => verifyPlan(root, crossed)).toThrow(/Cross-database/);
});
