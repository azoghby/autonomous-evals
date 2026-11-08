import { createHash } from 'node:crypto';
import { containsSecret } from '../../../agents/redact';
import type { CheckpointKey, TextCheckpointStore } from '../../integration/checkpoints';

/** Supplied from trusted, fresh application rows, never an HTTP request body. */
export interface ScenarioDispatchInput {
  ownerId: string; runId: string; environmentId: string; suiteId: string | null;
  scenarioId: string; worldId: string; k: number; budgetMicroUsd: number;
  environment: unknown; inventory: unknown; scenario: unknown; versions: unknown;
  /** Changes whenever the execution/validation contract changes. */
  engineVersion: string;
}
export type ScenarioDispatchOutcome<R> =
  | { status: 'completed'; replayed: boolean; value: R }
  | { status: 'unresolved'; reason: 'invalid_input' | 'unauthorized' | 'secret' | 'pending' | 'ambiguous' | 'storage' | 'invalid_result' };
export interface ScenarioDispatchDeps<R> {
  checkpoints: TextCheckpointStore;
  /** Re-read current ownership, plan/run authority, frozen inputs and world binding. No cached principal. */
  authorize(input: Readonly<ScenarioDispatchInput>): Promise<boolean>;
  currentSecrets(): Promise<readonly string[]>;
  /** Strict full-result validator, including scenario/trial/version consistency. Must not drop fields. */
  validateResult(value: unknown, input: Readonly<ScenarioDispatchInput>): R;
  /** All external effects belong here and use the supplied immutable input. No automatic retries. */
  execute(input: Readonly<ScenarioDispatchInput>): Promise<unknown>;
}
const VERSION = 'sandbox-scenario-dispatch.v1';
const MAX_BYTES = 8_000_000;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Strict canonical JSON: reject lossy values, accessors, custom prototypes and cycles. */
function encode(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) throw new Error('invalid_json');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new Error('invalid_json');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('invalid_json');
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(d => d.get || d.set) || Object.getOwnPropertySymbols(value).length) throw new Error('invalid_json');
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error('invalid_json');
      return `[${value.map(item => encode(item, seen)).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map(key => `${encode(key)}:${encode((value as Record<string, unknown>)[key], seen)}`).join(',')}}`;
  } finally { seen.delete(value); }
}
function detached<T>(value: T): { value: T; json: string } {
  const json = encode(value);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('too_large');
  return { value: JSON.parse(json) as T, json };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function sensitive(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === 'string') return containsSecret(value, secrets) || secrets.some(s => s.length > 0 && value.includes(s));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => sensitive(key, secrets) || sensitive(item, secrets));
  return false;
}
function inputCopy(raw: ScenarioDispatchInput): ScenarioDispatchInput {
  const input = detached(raw).value;
  const keys = ['ownerId', 'runId', 'environmentId', 'suiteId', 'scenarioId', 'worldId', 'k', 'budgetMicroUsd', 'environment', 'inventory', 'scenario', 'versions', 'engineVersion'];
  if (!input || Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k))) throw new Error('invalid_input');
  for (const key of ['ownerId', 'runId', 'environmentId', 'scenarioId', 'worldId', 'engineVersion'] as const) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 4096) throw new Error('invalid_input');
  }
  if (input.suiteId !== null && (typeof input.suiteId !== 'string' || !input.suiteId.trim() || input.suiteId.length > 4096)) throw new Error('invalid_input');
  if (!Number.isSafeInteger(input.k) || input.k < 1 || !Number.isSafeInteger(input.budgetMicroUsd) || input.budgetMicroUsd < 1) throw new Error('invalid_input');
  return freeze(input);
}

/** Whole-scenario fence. Unresolved NEVER authorizes finalization, world teardown, or fresh dispatch.
 * This does not replace per-call accounting, provider idempotency, or operator reconciliation. */
export function createScenarioDispatch<R>(deps: ScenarioDispatchDeps<R>) {
  return async (raw: ScenarioDispatchInput): Promise<ScenarioDispatchOutcome<R>> => {
    let input: ScenarioDispatchInput;
    try { input = inputCopy(raw); } catch { return { status: 'unresolved', reason: 'invalid_input' }; }
    const digest = hash(encode({ version: VERSION, input }));
    const key: CheckpointKey = {
      jobId: hash(encode([VERSION, input.runId])), kind: VERSION,
      id: hash(encode([input.scenarioId])), inputDigest: digest,
    };
    const allowed = async () => {
      try {
        if (!await deps.authorize(input)) return 'unauthorized' as const;
        if (sensitive(input, await deps.currentSecrets())) return 'secret' as const;
        return null;
      } catch { return 'unauthorized' as const; }
    };
    const refused = await allowed();
    if (refused) return { status: 'unresolved', reason: refused };
    let claim;
    try { claim = await deps.checkpoints.claim(key); }
    catch { return { status: 'unresolved', reason: 'storage' }; }
    if (claim.state === 'pending' || claim.state === 'ambiguous') return { status: 'unresolved', reason: claim.state };
    const validate = async (rawValue: unknown) => {
      const copy = detached(rawValue);
      const parsed = detached(deps.validateResult(copy.value, input));
      if (parsed.json !== copy.json) throw new Error('lossy_validator');
      if (sensitive(parsed.value, await deps.currentSecrets())) throw new Error('secret');
      return parsed.value;
    };
    const publish = async (value: R, replayed: boolean): Promise<ScenarioDispatchOutcome<R>> => {
      try {
        if (!await deps.authorize(input)) return { status: 'unresolved', reason: 'unauthorized' };
        const secrets = await deps.currentSecrets();
        if (sensitive(input, secrets) || sensitive(value, secrets)) return { status: 'unresolved', reason: 'secret' };
        return { status: 'completed', replayed, value };
      } catch { return { status: 'unresolved', reason: 'unauthorized' }; }
    };
    if (claim.state === 'completed') {
      try {
        const stored = detached(claim.value).value as { version: string; inputDigest: string; result: unknown };
        if (!stored || Object.keys(stored).sort().join(',') !== 'inputDigest,result,version' || stored.version !== VERSION || stored.inputDigest !== digest) throw new Error('invalid_result');
        const value = await validate(stored.result);
        return publish(value, true);
      } catch { return { status: 'unresolved', reason: 'invalid_result' }; }
    }
    // Do not release even if authority changes: this key is permanently bound and may be reconciled only explicitly.
    const ambiguous = async () => { try { await deps.checkpoints.markAmbiguous(key, claim.token); } catch { /* pending also fences replay */ } };
    const denied = await allowed();
    if (denied) { await ambiguous(); return { status: 'unresolved', reason: denied }; }
    let value: R;
    try { value = await validate(await deps.execute(input)); }
    catch { await ambiguous(); return { status: 'unresolved', reason: 'ambiguous' }; }
    // Preserve completed evidence before publication authorization; revocation cannot cause redispatch.
    try { await deps.checkpoints.complete(key, claim.token, { version: VERSION, inputDigest: digest, result: value }); }
    catch { await ambiguous(); return { status: 'unresolved', reason: 'storage' }; }
    return publish(value, false);
  };
}
