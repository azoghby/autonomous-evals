import { createHash } from 'node:crypto';
import { EnvironmentSpec, SandboxScenario, SANDBOX_SPEC_VERSION } from '../../sandbox/spec';

export class SandboxIdentityError extends Error {
  constructor() { super('sandbox_input_identity_invalid'); }
}
function reject(): never { throw new SandboxIdentityError(); }

// Object order is irrelevant; array order (tool order, scenarios and policy clauses) is retained.
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value) || value.includes('\0')) return reject();
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : reject();
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return reject();
  return '{' + Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => canonical(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function unique(values: readonly string[]): void {
  if (values.some(x => !x.trim()) || new Set(values).size !== values.length) reject();
}
export interface FrozenSandboxInputs {
  readonly identityVersion: 'sandbox-inputs.v1';
  readonly specVersion: typeof SANDBOX_SPEC_VERSION;
  readonly envHash: string;
  readonly suiteHash: string;
  readonly environment: EnvironmentSpec;
  readonly scenarios: readonly SandboxScenario[];
}

/** Identity only: this does not authorize SQL, attest oracle gates, approve a suite,
 * verify media or resolve credentials. Those require separate trusted evidence. */
export function freezeSandboxInputs(rawEnvironment: unknown, rawScenarios: unknown): FrozenSandboxInputs {
  try {
    // Bound JSON-shaped input before parsing. Reject cycles, non-JSON values and invalid text.
    const raw = structuredClone({ environment: rawEnvironment, scenarios: rawScenarios });
    if (Buffer.byteLength(canonical(raw), 'utf8') > 4_000_000) reject();
    const environment = EnvironmentSpec.parse(raw.environment);
    if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0 || raw.scenarios.length > 200) reject();
    const scenarios = raw.scenarios.map(s => SandboxScenario.parse(s));
    unique(environment.tools.map(t => t.name));
    unique(environment.workflows.map(w => w.id));
    unique(environment.policies.map(p => p.id));
    for (const p of environment.policies) unique(p.clauses.map(c => c.id));
    unique(scenarios.map(s => s.id));
    const tools = new Set(environment.tools.map(t => t.name));
    const workflows = new Set(environment.workflows.map(w => w.id));
    const hasTool = (name: string) => { if (!tools.has(name)) reject(); };
    for (const workflow of environment.workflows) workflow.tools.forEach(hasTool);
    for (const tool of environment.tools) {
      if (tool.binding.kind === 'sql' && tool.binding.resultFrom !== undefined
        && tool.binding.resultFrom >= tool.binding.statements.length) reject();
    }
    for (const scenario of scenarios) {
      if (!workflows.has(scenario.workflowId)) reject();
      unique([...scenario.stateAssertions, ...scenario.trajectoryAssertions, ...scenario.rubric,
        ...scenario.expectedChanges, ...scenario.requiredOutputs].map(c => c.id));
      unique(scenario.attachments.map(a => a.id));
      for (const fault of scenario.faults) hasTool(fault.tool);
      for (const assertion of scenario.trajectoryAssertions) {
        if (assertion.type === 'before') { hasTool(assertion.first); hasTool(assertion.then); }
        else if (assertion.tool !== undefined) hasTool(assertion.tool);
      }
    }
    const envHash = digest({ identityVersion: 'sandbox-inputs.v1', environment });
    const suiteHash = digest({ identityVersion: 'sandbox-inputs.v1', envHash, scenarios });
    return freeze({ identityVersion: 'sandbox-inputs.v1', specVersion: SANDBOX_SPEC_VERSION,
      envHash, suiteHash, environment, scenarios });
  } catch { return reject(); }
}

/** Reparse persisted inputs and compare both hashes; never trust stored flags or hashes alone. */
export function verifySandboxInputs(raw: unknown): FrozenSandboxInputs {
  try {
    if (!raw || typeof raw !== 'object') reject();
    const stored = raw as FrozenSandboxInputs;
    const result = freezeSandboxInputs(stored.environment, stored.scenarios);
    if (stored.identityVersion !== result.identityVersion || stored.specVersion !== result.specVersion
      || stored.envHash !== result.envHash || stored.suiteHash !== result.suiteHash) reject();
    return result;
  } catch { return reject(); }
}
