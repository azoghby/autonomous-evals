import { createHash } from 'node:crypto';
import type { EnvironmentSpec, SandboxScenario, SandboxRun, EvalVersions, StateDiff, ToolCallRecord } from '../../../sandbox/spec.js';
import { hashGradingScenario, ROW_DIFF_SQL, type RowAuthority, type RowMutation, type GradeInput, type GradingRun } from '../grading/index.js';
import type { RetainedSqlImage } from './sql.js';
export { capturePGliteImage } from './sql.js';
export type { RetainedSqlImage, SqlImageSource } from './sql.js';

/** Same canonical JSON identity as executionDigest; no new run or version labels. */
export function runtimeBridgeDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${Array.from(v, canonical).join(',')}]`;
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
      return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
    throw new Error('snapshot_identity_invalid');
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export interface RuntimeBinding {
  worldId: string;
  /** Exact executionDigest(input), supplied from the trusted execution composition. */
  executionIdentity: string;
  environment: EnvironmentSpec;
  scenario: SandboxScenario;
  versions: EvalVersions;
}
export interface PolicyRequest {
  runId: string; worldId: string; executionIdentity: string; scenarioHash: string;
  envHash: string; suiteHash: string; versions: EvalVersions;
}
/** Server policy is independently issued BEFORE observing the final diff. No actual-row input. */
export interface ExactRowPolicy extends PolicyRequest { policyId: string; allowed: RowMutation[] }
export interface SnapshotArtifact {
  runId: string | null; worldId: string | null; identityDigest: string;
  input: { environment: EnvironmentSpec; scenario: SandboxScenario; versions: EvalVersions };
  diff: StateDiff[] | null; toolCalls: ToolCallRecord[]; outbox: Record<string, unknown>[] | null;
}
export interface RuntimeSnapshot {
  run: GradingRun;
  evidence: Pick<GradeInput, 'completeDiff' | 'rowDiff' | 'rowAuthority'>;
  release(): Promise<void>;
}

/** Owns one actual runtime run. Caller must keep the raw run/DB private and route
 * every operation through `run`; all accepted operations drain before capture. */
export async function retainRuntimeRun(options: {
  run: SandboxRun;
  binding: RuntimeBinding;
  issuePolicy(request: PolicyRequest): Promise<ExactRowPolicy | null>;
  /** Must capture the actual run's entire independent immutable SQL world.
   * Invoked after diff refresh and quiescence, before raw dispose. */
  capture(): Promise<RetainedSqlImage>;
}) {
  const raw = options.run, binding = structuredClone(options.binding), runId = raw.runId;
  if (![runId, binding.worldId, binding.executionIdentity, ...Object.values(binding.versions)].every(v => typeof v === 'string' && v.trim()))
    throw new Error('snapshot_binding_missing');
  if (binding.versions.envHash !== runtimeBridgeDigest(binding.environment)) throw new Error('snapshot_environment_mismatch');
  const request: PolicyRequest = { runId, worldId: binding.worldId, executionIdentity: binding.executionIdentity,
    scenarioHash: hashGradingScenario(binding.scenario), envHash: binding.versions.envHash,
    suiteHash: binding.versions.suiteHash, versions: binding.versions };
  // Capture server policy now, rather than blessing changes after execution.
  const policy = structuredClone(await options.issuePolicy(structuredClone(request)));
  if (policy) {
    const { allowed: _, policyId, ...issued } = policy;
    if (!policyId?.trim() || runtimeBridgeDigest(issued) !== runtimeBridgeDigest(request)) throw new Error('snapshot_policy_binding_mismatch');
  }
  let tail: Promise<unknown> = Promise.resolve(), sealing = false;
  let sealed: Promise<void> | undefined, disposed: Promise<void> | undefined;
  let forgotten = false, leases = 0;
  let retained: { image: RetainedSqlImage; snapshotId: string; diff: StateDiff[]; calls: ToolCallRecord[]; outbox: Record<string, unknown>[] } | undefined;
  const serial = <T>(fn: () => Promise<T>) => {
    const next = tail.then(fn); tail = next.catch(() => undefined); return next;
  };
  const active = <T>(fn: () => Promise<T>): Promise<T> => sealing ? Promise.reject(new Error('snapshot_run_sealed')) : serial(fn);
  function seal(): Promise<void> {
    if (sealed) return sealed;
    sealing = true;
    sealed = serial(async () => {
      const diff = structuredClone(await raw.diff()); // refreshes actual sandbox_diff
      const calls = structuredClone(raw.trajectory());
      const outbox = structuredClone(await raw.outbox());
      const image = await options.capture();
      const snapshotId = runtimeBridgeDigest({ request, image: image.digest, diff, calls, outbox });
      retained = { image, snapshotId, diff, calls, outbox };
    });
    return sealed;
  }
  // Older runtime contracts have no trusted exec hook. Preserve it only when
  // supplied by the actual runtime; never emulate writes through query.
  const exec = (raw as SandboxRun & { exec?: (sql: string) => Promise<void> }).exec;
  const run: SandboxRun & { exec?: (sql: string) => Promise<void> } = {
    runId,
    ...(typeof exec === 'function' ? { exec: (sql: string) => active(() => exec.call(raw, sql)) } : {}),
    callTool(name, args) { const pinned = structuredClone(args); return active(async () => structuredClone(await raw.callTool(name, pinned))); },
    query(sql, params = []) { const pinned = structuredClone(params); return active(() => raw.query(sql, pinned)); },
    diff: () => active(() => raw.diff()), outbox: () => active(() => raw.outbox()),
    trajectory: () => structuredClone(raw.trajectory()),
    dispose() {
      if (!disposed) disposed = (async () => {
        try { await seal(); } finally { await raw.dispose(); }
      })();
      return disposed;
    },
  };
  async function snapshot(): Promise<RuntimeSnapshot> {
    await seal();
    if (forgotten) throw new Error('snapshot_forgotten');
    const r = retained!;
    leases++; // reserve before asynchronous open so forget cannot race it
    let db: Awaited<ReturnType<RetainedSqlImage['open']>>;
    try { db = await r.image.open(); } catch (error) { leases--; throw error; }
    let released = false;
    // Match the restored complete relation to summary totals before attesting it.
    // The grader independently validates row shapes, keys and exact permissions.
    try {
      const rows = await db.query(ROW_DIFF_SQL);
      const counts = new Map<string, { inserted: number; updated: number; deleted: number }>();
      for (const row of rows) {
        if (typeof row.table_name !== 'string' || !['inserted', 'updated', 'deleted'].includes(String(row.change))) throw new Error('snapshot_relation_invalid');
        const c = counts.get(row.table_name) ?? { inserted: 0, updated: 0, deleted: 0 };
        c[row.change as 'inserted']++; counts.set(row.table_name, c);
      }
      if (counts.size !== r.diff.length || r.diff.some(d => {
        const c = counts.get(d.table); return !c || c.inserted !== d.inserted || c.updated !== d.updated || c.deleted !== d.deleted;
      })) throw new Error('snapshot_relation_incomplete');
    } catch { try { await db.close(); } finally { leases--; } throw new Error('snapshot_relation_unavailable'); }
    const authority: RowAuthority | undefined = policy ? { runId, snapshotId: r.snapshotId, scenarioHash: request.scenarioHash,
      envHash: request.envHash, suiteHash: request.suiteHash, allowed: structuredClone(policy.allowed) } : undefined;
    return {
      run: { runId, query: (sql, params) => released ? Promise.reject(new Error('snapshot_released')) : db.query(sql, params),
        diff: async () => { if (released) throw new Error('snapshot_released'); return structuredClone(r.diff); },
        trajectory: () => { if (released) throw new Error('snapshot_released'); return structuredClone(r.calls); } },
      evidence: { completeDiff: { runId, allTables: true, snapshotId: r.snapshotId },
        rowDiff: { runId, snapshotId: r.snapshotId, allRows: true, relation: 'sandbox_diff' }, ...(authority ? { rowAuthority: authority } : {}) },
      async release() { if (!released) { released = true; try { await db.close(); } finally { leases--; } } },
    };
  }
  return {
    run, seal,
    /** Explicit local retention cleanup, after raw disposal and all leases release.
     * A durable backend must implement its own authorized TTL/reaper. */
    async forget() {
      if (!disposed) throw new Error('snapshot_run_not_disposed');
      await disposed;
      if (leases) throw new Error('snapshot_leases_active');
      forgotten = true;
      retained = undefined;
    },
    /** Gate owner may call after reference execution; seals that exact run permanently. */
    gateSnapshot: snapshot,
    /** Structurally implements SandboxEngineAuthority.finalSnapshot for this run. */
    async finalSnapshot(artifact: SnapshotArtifact): Promise<RuntimeSnapshot> {
      artifact = structuredClone(artifact);
      await seal();
      if (forgotten) throw new Error('snapshot_forgotten');
      const r = retained!;
      if (artifact.runId !== runId || artifact.worldId !== binding.worldId || artifact.identityDigest !== binding.executionIdentity ||
        runtimeBridgeDigest(artifact.input.environment) !== runtimeBridgeDigest(binding.environment) ||
        hashGradingScenario(artifact.input.scenario) !== request.scenarioHash ||
        runtimeBridgeDigest(artifact.input.versions) !== runtimeBridgeDigest(binding.versions) ||
        runtimeBridgeDigest(artifact.diff) !== runtimeBridgeDigest(r.diff) || runtimeBridgeDigest(artifact.toolCalls) !== runtimeBridgeDigest(r.calls) ||
        runtimeBridgeDigest(artifact.outbox) !== runtimeBridgeDigest(r.outbox)) throw new Error('snapshot_execution_mismatch');
      return snapshot();
    },
  };
}
