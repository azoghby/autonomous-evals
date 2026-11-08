/**
 * Internal seams of the sandbox runtime (not part of the cross-team contract in ../spec.ts).
 * Every module in this folder codes against these interfaces so pieces can be tested with fakes.
 */
import type { ToolSpec } from "../spec";

/* ---------------- SQL connection ---------------- */

export interface SqlResult<T = Record<string, unknown>> { rows: T[]; rowCount: number }

/** One pinned session (BEGIN/COMMIT are meaningful). Implemented over @neondatabase/serverless Client or PGlite in tests. */
export interface SqlConn {
  /** Single statement, extended protocol, positional $n params. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
  /** Multi-statement script, simple protocol, no params. */
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

/** Opens a session to a database by connection string. */
export type SqlConnector = (connectionString: string) => Promise<SqlConn>;

/* ---------------- Neon branches ---------------- */

export interface BranchInfo { branchId: string; name: string; parentId?: string; expiresAt?: string | null }

export interface NeonBranchManager {
  /** Creates a branch (with a read_write endpoint), waits for all its operations to finish. Serialized per project; retries 423. */
  createBranch(opts: { name: string; parentId: string; expiresAt?: Date }): Promise<BranchInfo>;
  /** Direct (non-pooled) connection URI for a database on the branch. Role defaults to the branch's first non-system role. */
  connectionUri(branchId: string, databaseName: string, roleName?: string): Promise<string>;
  /** Reset a branch to its parent's latest state (POST /branches/{b}/restore {source_branch_id: parent}); waits for operations. */
  resetFromParent(branchId: string, parentId: string): Promise<void>;
  /** Deletes a branch; 404 counts as success. Waits for operations. */
  deleteBranch(branchId: string): Promise<void>;
  listBranches(): Promise<BranchInfo[]>;
  /** The project's default branch id (used when no parent is configured). */
  defaultBranchId(): Promise<string>;
}

/* ---------------- tool execution ---------------- */

export type FaultKind = "http_500" | "timeout" | "empty_result" | "stale_data" | "rate_limited" | "injected_instruction";

/** Context a simulated tool gets: a snapshot of the rows it declared in readsTables (capped). */
export interface StateSnapshot { [table: string]: Array<Record<string, unknown>> }

export interface SimulatedOutput {
  /** The tool result returned to the agent (validated against outputSchema when present). */
  result: unknown;
  /** Side effects to record in sandbox_outbox when binding.recordsOutbox (e.g. the email that "was sent"). */
  sideEffects?: Array<Record<string, unknown>>;
}

/** Injected dependency for `simulated` bindings. */
export type Simulate = (tool: ToolSpec, args: unknown, state: StateSnapshot) => Promise<SimulatedOutput>;
