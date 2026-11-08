import type { AgentTaskRunner, AgentTaskSpec } from '../session-service';
import type { PostgresAutonomySupervisor } from './supervisor';
import { autonomyDigest } from './policy';
import { containsSecret } from '../redact';

/** Additive policy envelope around the existing SQL-backed session service. The server MUST
 * construct that service's directory from supervisor.policy.agents (agentId + agentVersion).
 * Session service remains the sole monetary reservation ledger for these calls. */
export function createAutonomousRunner(config: {
 supervisor: PostgresAutonomySupervisor; runner: AgentTaskRunner; now(): number;
 currentPolicyVersion(): Promise<string>; currentSecrets(): Promise<readonly string[]>;
}): AgentTaskRunner {
 return {async run<T>(spec: AgentTaskSpec<T>) {
  const p=config.supervisor.policy, exact=p.agents[spec.role];
  const knownSecrets=await config.currentSecrets();
  if (await config.currentPolicyVersion()!==p.version || containsSecret(spec.message,knownSecrets)) throw new Error('autonomous_runner_current_guard');
  const decision=await config.supervisor.authorizeDecision({tenantId:p.tenantId,jobId:spec.job.jobId,
   key:`session:${autonomyDigest({job:spec.job.jobId,role:spec.role,purpose:spec.purpose,attempt:spec.attempt??1})}`,
   role:spec.role,agentId:exact.id,agentVersion:exact.version,kind:'agent_task',
   inputDigest:autonomyDigest({job:spec.job,role:spec.role,purpose:spec.purpose,message:spec.message,budget:spec.budgetMicroUsd,outputName:spec.output.name}),
  },config.now());
  if(!decision.allowed)throw new Error(`autonomous_runner_${decision.reason}`);
  const outcome=await config.runner.run({...spec,knownSecrets,jobCapMicroUsd:Math.min(spec.jobCapMicroUsd ?? Number.MAX_SAFE_INTEGER,spec.job.package === 'version_comparison' ? p.comparisonJobCapMicroUsd : p.singleJobCapMicroUsd)});
  if('session' in outcome && outcome.session && (outcome.session.agentId!==exact.id || outcome.session.agentVersion!==exact.version)) throw new Error('autonomous_runner_agent_identity_mismatch');
  return outcome;
 }};
}
