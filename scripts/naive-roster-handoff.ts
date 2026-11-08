/** Offline private application handoff. Retained receipts never establish live authority. */
import { COMPANY_COORDINATOR_ROLES, COMPANY_ROLE_DEFINITIONS, type CompanyRole } from '../packages/core/src/agents/company-roles';
import { buildCompanyProvisionPlan } from '../packages/core/src/agents/company-provision-plan';
import { configFingerprint } from '../packages/core/src/agents/naive-provisioning';
import { validateRosterReceiptChain } from './naive-roster-config';

const fail = (): never => { throw new Error('Complete exact roster receipt chain required for application handoff'); };
const roleNames = Object.keys(COMPANY_ROLE_DEFINITIONS) as CompanyRole[];
/** No key reads, provider calls, environment mutation, or activation. Output intentionally omits private spec inputs. */
export function buildRosterApplicationHandoff(rawSpec: unknown, exports: readonly unknown[]) {
  const chain = validateRosterReceiptChain(rawSpec, exports);
  if (chain.completedStages !== 5) fail();
  const { spec, receipts } = chain;
  const plan = buildCompanyProvisionPlan({ ...spec, stage: 'deployments', receipts, schedules: Object.fromEntries(Object.entries(spec.schedules).map(([role, schedule]) => [role, { ...schedule, onIdleUrl: spec.onIdleUrl }])) });
  const terminal = chain.exports[4];
  if (!terminal || terminal.stage !== 'deployments' || terminal.resources.length !== plan.operations.length) fail();
  const seen = new Set<string>();
  const deployments = plan.operations.map((op, index) => {
    if (op.kind !== 'deployment') return fail();
    const resource = terminal.resources[index];
    if (!resource || resource.kind !== 'deployment' || resource.name !== op.name || resource.version !== undefined || seen.has(resource.id)) return fail();
    seen.add(resource.id);
    const role = roleNames.find(role => receipts.agents?.[role]?.name === op.name);
    if (!role) return fail();
    const agent = receipts.agents![role]!;
    if (op.body.agent_id !== agent.id || op.body.agent_version !== agent.version || op.body.enabled !== false) fail();
    return { role, name: op.name, deploymentId: resource.id, agentId: agent.id, agentVersion: agent.version,
      agentPin: `${agent.id}@${agent.version}`, enabled: false as const,
      schedule: { cron: op.body.cron, timezone: op.body.timezone, budgetMicroUsd: op.body.budget_micro_usd,
        inputTemplateFingerprint: configFingerprint(op.body.input_template) } };
  });
  const roles = roleNames.map(role => {
    const definition = COMPANY_ROLE_DEFINITIONS[role], agent = receipts.agents?.[role];
    if (!agent) return fail();
    const mcpTools = Object.fromEntries(Object.entries(definition.tools).filter(([name]) => name.startsWith('se_internal.')));
    return { role, name: agent.name, env: definition.env, agentId: agent.id, agentVersion: agent.version,
      pin: `${agent.id}@${agent.version}`, configurationFingerprint: agent.configurationFingerprint,
      mcpTools, ...(Object.keys(mcpTools).length ? { credentialId: receipts.credentials![role]!.id, vaultId: receipts.vaults![role]!.id } : {}) };
  });
  return {
    schemaVersion: 'naive_roster_application_handoff.v1' as const,
    visibility: 'private' as const,
    evidence: 'retained_attestation_not_fresh_authority' as const,
    source: { specSchemaVersion: spec.schemaVersion, rolloutFingerprint: chain.rolloutFingerprint,
      stages: chain.exports.map(row => ({ stage: row.stage, planFingerprint: row.planFingerprint })) },
    revision: spec.revision,
    appOrigin: spec.appOrigin,
    applyReady: false as const,
    environment: Object.fromEntries(roles.map(role => [role.env, role.pin])),
    roles, deployments,
    coordinator: { role: 'planner' as const, pin: roles.find(role => role.role === 'planner')!.pin,
      members: COMPANY_COORDINATOR_ROLES.map(role => ({ role, pin: roles.find(row => row.role === role)!.pin })) },
    // Paths and query strings can contain callback credentials; retain only origin, contract, and digest.
    callbacks: { origin: new URL(spec.onIdleUrl).origin, pathTemplate: '/api/naive/idle/{redacted-token}', contract: 'authenticated idle receiver; callback is a wakeup, authoritative state must be fetched',
      configuredUrlFingerprint: configFingerprint(spec.onIdleUrl) },
    internalMcp: { origin: new URL(spec.internalMcpUrl).origin, path: '/api/mcp/internal/mcp', configuredUrlFingerprint: configFingerprint(spec.internalMcpUrl) },
    blockers: [
      'Internal MCP transport and exact manifest tool handlers require implementation and acceptance.',
      'Agent-bound bearer hash registry, rotation and revocation require implementation and acceptance.',
      'Scoped task-token issuance, verification and current authority checks require implementation and acceptance.',
      'Authenticated idle callback, authoritative reconciliation and idempotent accounting require acceptance.',
      'Pause controls, approval enforcement and budget controls require current hosted acceptance.',
      'Current application configuration readers and explicit activation require owner integration; these pins do not activate runtime configuration.',
      'Fresh provider attestation and skill version resolution require verification before activation.',
    ],
  };
}
