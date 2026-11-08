import { createHash } from 'node:crypto';

export const AUTONOMY_ROLES = ['commercial', 'evaluation_engineer', 'quality_investigator', 'company_operator'] as const;
export type AutonomyRole = typeof AUTONOMY_ROLES[number];
export type AutonomousPolicy = Readonly<{
  schema: 'autonomous-company-policy/v1'; version: string; tenantId: string; periodId: string;
  enabled: true; rootBudgetMicroUsd: number;
  singleJobCapMicroUsd: number; comparisonJobCapMicroUsd: number;
  roleCapsMicroUsd: Readonly<Record<AutonomyRole, number>>;
  agents: Readonly<Record<AutonomyRole, Readonly<{ id: string; version: number }>>>;
  allowedActions: readonly string[]; leaseMs: number; actionDeadlineMs: number; maxRecoveryChecks: number;
}>;
export function canonicalAutonomy(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('invalid_autonomy_value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalAutonomy).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalAutonomy((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const autonomyDigest = (value: unknown) => createHash('sha256').update(canonicalAutonomy(value)).digest('hex');
export function assertAutonomyInteger(n: number, minimum = 0): void {
  if (!Number.isSafeInteger(n) || n < minimum) throw new Error('invalid_autonomy_integer');
}
export function assertAutonomyId(s: string): void {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_.:@/-]{1,200}$/.test(s)) throw new Error('invalid_autonomy_identity');
}
/** Called ONLY by the server composition root. Neither agent output nor intake is a policy source.
 * Omission preserves legacy manual mode: no implicit default enables autonomy. */
export function createAutonomousPolicy(input: AutonomousPolicy): AutonomousPolicy {
  const p = structuredClone(input);
  if (p.schema !== 'autonomous-company-policy/v1' || p.enabled !== true) throw new Error('explicit_autonomous_policy_required');
  for (const s of [p.version, p.tenantId, p.periodId]) assertAutonomyId(s);
  assertAutonomyInteger(p.rootBudgetMicroUsd, 1);
  for (const n of [p.singleJobCapMicroUsd, p.comparisonJobCapMicroUsd, p.leaseMs, p.actionDeadlineMs, p.maxRecoveryChecks]) assertAutonomyInteger(n, 1);
  if (p.leaseMs > p.actionDeadlineMs || p.maxRecoveryChecks > 100 || p.actionDeadlineMs > 7 * 86400000) throw new Error('unbounded_autonomy_recovery');
  if (p.singleJobCapMicroUsd > p.rootBudgetMicroUsd || p.comparisonJobCapMicroUsd > p.rootBudgetMicroUsd) throw new Error('autonomy_job_cap_exceeds_root');
  let total = 0;
  for (const role of AUTONOMY_ROLES) {
    assertAutonomyInteger(p.roleCapsMicroUsd[role]); total += p.roleCapsMicroUsd[role];
    assertAutonomyId(p.agents[role].id); assertAutonomyInteger(p.agents[role].version, 1);
    Object.freeze(p.agents[role]);
  }
  if (!Number.isSafeInteger(total) || total > p.rootBudgetMicroUsd) throw new Error('autonomy_role_caps_exceed_root');
  if (!p.allowedActions.length || new Set(p.allowedActions).size !== p.allowedActions.length) throw new Error('invalid_autonomy_actions');
  p.allowedActions.forEach(assertAutonomyId);
  Object.freeze(p.agents); Object.freeze(p.roleCapsMicroUsd); Object.freeze(p.allowedActions);
  return Object.freeze(p);
}
/** PLAN defaults: overrides must be explicit server configuration within the existing root. */
export const DEFAULT_AUTONOMY_CAPS = Object.freeze({ singleJobCapMicroUsd: 3_000_000, comparisonJobCapMicroUsd: 5_000_000,
  roleCapsMicroUsd: Object.freeze({ commercial: 35_000_000, evaluation_engineer: 65_000_000, quality_investigator: 65_000_000, company_operator: 35_000_000 }) });
