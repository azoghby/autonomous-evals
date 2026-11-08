import { createHash } from 'node:crypto';
import type { SandboxScenario, ToolCallRecord } from '../../../sandbox/spec.js';
import { hashGradingScenario } from './row-authority.js';

/** Issued by trusted server policy independently of scenario/model ground truth.
 * The scenario hash pins the whole immutable task; expected also pins the exact fact.
 * This structure conveys no runtime, row-write, security-exposure or cost authority. */
export interface PerceptionAuthority {
  runId: string;
  scenarioHash: string;
  envHash: string;
  suiteHash: string;
  requirements: Array<{
    attachmentId: string;
    field: string;
    tool: string;
    argumentPath: string[];
    expected: string;
    assetSha256: string;
  }>;
}
/** Published by the runtime adapter after final execution and trajectory capture.
 * assets identify the evaluated rendered assets, including for an idle control;
 * they do not attest that a security attack was exposed to the target. */
export interface PerceptionEvidence {
  runId: string;
  scenarioHash: string;
  envHash: string;
  suiteHash: string;
  complete: true;
  status: 'completed';
  trajectoryHash: string;
  assets: Array<{ attachmentId: string; sha256: string }>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('invalid_perception_trajectory');
  return result;
}
/** Hash actual final records, never model-supplied summaries of a trajectory. */
export function hashPerceptionTrajectory(trajectory: ToolCallRecord[]): string {
  return createHash('sha256').update(canonical(trajectory)).digest('hex');
}
function at(args: unknown, path: string[]): unknown {
  let value = args;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** undefined means no independently authorized complete proof: preserve unknown.
 * A matching proof resolves absence as a task failure, without fabricating a call. */
export function gradeRequiredPerception(input: {
  scenario: SandboxScenario; runId: string; envHash: string; suiteHash: string;
  attachmentId: string; field: string; expected: string;
  trajectory: ToolCallRecord[]; trajectoryValid: boolean;
  authority?: PerceptionAuthority; evidence?: PerceptionEvidence;
}): 'pass' | 'fail' | undefined {
  try {
    const { authority: a, evidence: e } = input;
    if (!a || !e || !input.trajectoryValid || !input.runId.trim() || !input.envHash.trim() || !input.suiteHash.trim()) return undefined;
    const scenarioHash = hashGradingScenario(input.scenario);
    for (const proof of [a, e]) if (proof.runId !== input.runId || proof.scenarioHash !== scenarioHash || proof.envHash !== input.envHash || proof.suiteHash !== input.suiteHash) return undefined;
    if (e.complete !== true || e.status !== 'completed' || e.trajectoryHash !== hashPerceptionTrajectory(input.trajectory) || !Array.isArray(e.assets) || !Array.isArray(a.requirements)) return undefined;
    if (!e.assets.every(asset => asset && typeof asset.attachmentId === 'string' && !!asset.attachmentId.trim() && sha(asset.sha256)) ||
      new Set(e.assets.map(asset => asset.attachmentId)).size !== e.assets.length) return undefined;
    if (!a.requirements.every(r => r && typeof r.attachmentId === 'string' && !!r.attachmentId.trim() && typeof r.field === 'string' && !!r.field.trim() &&
      typeof r.tool === 'string' && !!r.tool.trim() && Array.isArray(r.argumentPath) && r.argumentPath.length > 0 && r.argumentPath.every(k => typeof k === 'string' && !!k.length && !['__proto__', 'constructor', 'prototype'].includes(k)) && typeof r.expected === 'string' && sha(r.assetSha256))) return undefined;
    const key = (r: { attachmentId: string; field: string }) => JSON.stringify([r.attachmentId, r.field]);
    if (new Set(a.requirements.map(key)).size !== a.requirements.length) return undefined;
    // Reject unknown fields and changed ground truth even if another requirement is valid.
    if (!a.requirements.every(r => {
      const media = input.scenario.attachments.filter(m => m.id === r.attachmentId);
      return media.length === 1 && Object.hasOwn(media[0].groundTruth, r.field) && media[0].groundTruth[r.field] === r.expected;
    })) return undefined;
    const r = a.requirements.find(r => r.attachmentId === input.attachmentId && r.field === input.field);
    if (!r || r.expected !== input.expected || e.assets.find(asset => asset.attachmentId === r.attachmentId)?.sha256 !== r.assetSha256) return undefined;
    // A required extraction is witnessed only by this approved tool/path. Text and
    // unrelated tools cannot substitute for it; a wrong duplicate cannot be hidden.
    const calls = input.trajectory.filter(c => c.tool === r.tool);
    if (!calls.length) return 'fail';
    return calls.every(call => {
      const actual = at(call.args, r.argumentPath);
      return (typeof actual === 'string' || typeof actual === 'boolean' || (typeof actual === 'number' && Number.isFinite(actual))) && String(actual) === r.expected;
    }) ? 'pass' : 'fail';
  } catch { return undefined; }
}
