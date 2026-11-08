/** Operator diagnostic limits are distinct from production role ceilings. */
import type { AgentRole } from "../evals/types";
export type DiagnosticDirectory = Record<AgentRole, { agentId: string; agentVersion: number }>;
export interface DiagnosticPolicyInput {
  directory: DiagnosticDirectory;
  budgetPeriodId: string;
  runId: string;
  stateFile: string;
  perSessionMicroUsd?: number;
  totalMicroUsd?: number;
  maxWaitMs?: number;
  /** Compatibility only: provisioning is no longer performed by diagnostics. */
  provision?: false;
}
const roles: AgentRole[] = ["commercial", "evaluation_engineer", "quality_investigator", "company_operator"];
export function diagnosticPolicy(input: DiagnosticPolicyInput) {
  const invalid = () => { throw new Error("Invalid live diagnostic policy"); };
  if (!input || (input.provision !== undefined && input.provision !== false) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.runId) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.budgetPeriodId) ||
      typeof input.stateFile !== "string" || !input.stateFile.trim() || /[\0\r\n]/.test(input.stateFile)) invalid();
  const per = input.perSessionMicroUsd ?? 250_000, total = input.totalMicroUsd ?? 1_000_000;
  if (!Number.isSafeInteger(per) || per <= 0 || per > 250_000 ||
      !Number.isSafeInteger(total) || total < per * roles.length || total > 1_000_000 ||
      (input.maxWaitMs !== undefined && (!Number.isSafeInteger(input.maxWaitMs) || input.maxWaitMs <= 0))) invalid();
  if (!input.directory || Object.keys(input.directory).length !== roles.length) invalid();
  const ids = new Set<string>();
  const directory = {} as DiagnosticDirectory;
  for (const role of roles) {
    const pin = input.directory[role];
    if (!Object.prototype.hasOwnProperty.call(input.directory, role) || !pin || !/^agt_[0-9a-hjkmnp-tv-z]{26}$/.test(pin.agentId) ||
        !Number.isSafeInteger(pin.agentVersion) || pin.agentVersion <= 0 || ids.has(pin.agentId)) invalid();
    ids.add(pin.agentId);
    directory[role] = { agentId: pin.agentId, agentVersion: pin.agentVersion };
  }
  return { per, total, directory, budgetPeriodId: input.budgetPeriodId };
}
