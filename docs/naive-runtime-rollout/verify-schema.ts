/** Offline only: reads pinned repository files and creates ephemeral in-memory PGlite instances.
 * Never imports application configuration, reads credentials, or connects to a database URL.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

export interface FilePin { path: string; sha256: string }
export interface Migration extends FilePin { id: string; dependsOn: string[]; aliases: FilePin[]; database: string }
export interface SchemaPlan {
  version: number; adoptedCommit: string; liveActions: false; applyMigrations: false;
  baseMigrations: Migration[]; sidecars: Migration[]; canonicalOrder: string[];
  profiles: Record<string, string[]>; evidence: FilePin[];
}
export interface VerifiedPlan { plan: SchemaPlan; sql: Map<string, string> }
export function readPlan(root: string): SchemaPlan {
  return JSON.parse(readFileSync(resolve(root, 'docs/naive-runtime-rollout/schema-plan.json'), 'utf8'));
}
function fail(message: string): never { throw new Error(message); }
function pinnedFile(root: string, pin: FilePin): string {
  if (!pin || typeof pin.path !== 'string' || isAbsolute(pin.path)) fail('Invalid relative file pin');
  const full = realpathSync(resolve(root, pin.path));
  const rel = relative(realpathSync(root), full);
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`File escapes repository: ${pin.path}`);
  const bytes = readFileSync(full);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(pin.sha256) || hash !== pin.sha256) fail(`SHA-256 mismatch: ${pin.path}`);
  return bytes.toString('utf8');
}
export function verifyPlan(root: string, plan: SchemaPlan = readPlan(root)): VerifiedPlan {
  if (plan.version !== 1 || plan.liveActions !== false || plan.applyMigrations !== false) fail('Offline plan policy mismatch');
  if (!/^[a-f0-9]{40}$/.test(plan.adoptedCommit)) fail('Missing adopted commit pin');
  const entries = [...plan.baseMigrations, ...plan.sidecars];
  const byId = new Map<string, Migration>(), paths = new Set<string>(), hashes = new Set<string>();
  const sql = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.id || byId.has(entry.id)) fail(`Duplicate migration id: ${entry.id}`);
    if (paths.has(entry.path)) fail(`Duplicate canonical path: ${entry.path}`);
    if (hashes.has(entry.sha256)) fail(`Duplicate canonical content; use alias: ${entry.path}`);
    if (!Array.isArray(entry.dependsOn) || !Array.isArray(entry.aliases)) fail(`Invalid migration: ${entry.id}`);
    byId.set(entry.id, entry); paths.add(entry.path); hashes.add(entry.sha256);
    sql.set(entry.id, pinnedFile(root, entry));
    for (const alias of entry.aliases) {
      if (paths.has(alias.path)) fail(`Repeated alias path: ${alias.path}`);
      paths.add(alias.path);
      if (alias.sha256 !== entry.sha256) fail(`Alias content differs: ${alias.path}`);
      pinnedFile(root, alias);
    }
  }
  // Explicit DFS distinguishes dependency cycles from merely incorrect ordering.
  const active = new Set<string>(), done = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) fail(`Dependency cycle: ${id}`);
    if (done.has(id)) return;
    const entry = byId.get(id); if (!entry) fail(`Unknown dependency: ${id}`);
    active.add(id);
    if (new Set(entry.dependsOn).size !== entry.dependsOn.length) fail(`Repeated dependency: ${id}`);
    for (const dependency of entry.dependsOn) visit(dependency);
    active.delete(id); done.add(id);
  }
  for (const entry of entries) visit(entry.id);
  function ordered(ids: string[], label: string) {
    const seen = new Set<string>();
    for (const id of ids) {
      const entry = byId.get(id); if (!entry) fail(`Unknown migration in ${label}: ${id}`);
      if (seen.has(id)) fail(`Migration replay in ${label}: ${id}`);
      for (const dependency of entry.dependsOn) if (!seen.has(dependency)) fail(`Missing or out-of-order dependency in ${label}: ${id} requires ${dependency}`);
      seen.add(id);
    }
    return seen;
  }
  if (ordered(plan.canonicalOrder, 'canonicalOrder').size !== entries.length) fail('canonicalOrder omits migrations');
  for (const [name, ids] of Object.entries(plan.profiles)) ordered(ids, name);
  for (const required of ['application', 'optionalApplication', 'simulator']) if (!plan.profiles[required]?.length) fail(`Missing profile: ${required}`);
  // Every real Drizzle migration must be present exactly once in journal order.
  const journal = JSON.parse(readFileSync(resolve(root, 'packages/core/src/db/migrations/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const expected = journal.entries.map(entry => `packages/core/src/db/migrations/${entry.tag}.sql`);
  if (JSON.stringify(plan.baseMigrations.map(entry => entry.path)) !== JSON.stringify(expected)) fail('Base migrations differ from Drizzle journal');
  for (const name of ['application', 'optionalApplication']) {
    const prefix = plan.profiles[name].slice(0, plan.baseMigrations.length);
    if (JSON.stringify(prefix) !== JSON.stringify(plan.baseMigrations.map(entry => entry.id))) fail(`Missing base migrations in ${name}`);
  }
  const inventory = JSON.parse(readFileSync(resolve(root, 'docs/naive-current-runtime-adoption/sql-inventory.json'), 'utf8')) as { entries: FilePin[] };
  const expectedPaths = new Set(inventory.entries.map(entry => entry.path));
  if (paths.size !== expectedPaths.size || [...paths].some(path => !expectedPaths.has(path))) fail('SQL inventory coverage differs');
  for (const name of ['application', 'optionalApplication', 'simulator']) {
    const database = name === 'simulator' ? 'simulator' : 'application';
    if (plan.profiles[name].some(id => byId.get(id)!.database !== database)) fail(`Cross-database profile: ${name}`);
  }
  for (const pin of plan.evidence) pinnedFile(root, pin);
  return { plan, sql };
}
export interface ApplicationReceipt { profile: string; applied: string[]; database: 'in-memory PGlite'; liveActions: false }
export async function applyProfile(verified: VerifiedPlan, profile: string): Promise<ApplicationReceipt> {
  const ids = verified.plan.profiles[profile]; if (!ids) fail(`Unknown profile: ${profile}`);
  // No dataDir/URL argument: PGlite is isolated and ephemeral by construction.
  const pg = new PGlite();
  const applied: string[] = [];
  try {
    for (const id of ids) {
      const source = verified.sql.get(id); if (source === undefined) fail(`Unverified migration: ${id}`);
      try { await pg.exec(source); }
      catch (error) { throw new Error(`Migration failed (${profile}, ${id}); stopped after ${applied.length}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      applied.push(id);
    }
    return { profile, applied, database: 'in-memory PGlite', liveActions: false };
  } finally { await pg.close(); }
}

// Optional standalone entry point; the fixed root prevents accidentally selecting a live target.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'verify-schema.ts')) {
  const root = resolve(import.meta.dirname, '../..');
  (async () => {
    const checked = verifyPlan(root);
    const receipts: ApplicationReceipt[] = [];
    for (const profile of ['application', 'optionalApplication', 'simulator']) receipts.push(await applyProfile(checked, profile));
    console.log(JSON.stringify({ verified: true, adoptedCommit: checked.plan.adoptedCommit, liveActions: false, receipts }, null, 2));
  })().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
