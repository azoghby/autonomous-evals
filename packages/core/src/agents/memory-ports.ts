/**
 * In-memory reference implementations of the durable ports.
 * FOR TESTS AND LOCAL DEVELOPMENT ONLY: they lose state on restart. Track A provides Neon-backed
 * implementations with the same semantics (reference SQL in docs/track-b-agents.md).
 * Each method does its check-and-write without awaiting in between, which is what makes it atomic here;
 * in Postgres the same guarantee comes from a single transaction with row locks.
 */
import type {
  AgentTaskPatch,
  AgentTaskRecord,
  AgentTaskStore,
  BudgetLedger,
  BudgetReservationRequest,
  BudgetReservationResult,
  MicroUsd,
} from "../evals/types";

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryAgentTaskStore implements AgentTaskStore {
  readonly rows = new Map<string, AgentTaskRecord>();

  async get(taskKey: string) {
    const row = this.rows.get(taskKey);
    return row ? clone(row) : null;
  }

  async insertIfAbsent(record: AgentTaskRecord) {
    const existing = this.rows.get(record.taskKey);
    if (existing) return { inserted: false, record: clone(existing) };
    this.rows.set(record.taskKey, clone({ ...record, revision: 0 }));
    return { inserted: true, record: clone(this.rows.get(record.taskKey)!) };
  }

  async compareAndSet(taskKey: string, expectedRevision: number, patch: AgentTaskPatch) {
    const row = this.rows.get(taskKey);
    if (!row || row.revision !== expectedRevision) return null;
    const next = { ...row, ...clone(patch), revision: row.revision + 1 };
    this.rows.set(taskKey, next);
    return clone(next);
  }
}

interface Reservation {
  id: string;
  jobId: string;
  scopes: string[];
  reservedMicroUsd: MicroUsd;
  settledMicroUsd: MicroUsd | null;
  firstResult: BudgetReservationResult;
}

export class InMemoryBudgetLedger implements BudgetLedger {
  /** scope key -> cap */
  readonly caps = new Map<string, MicroUsd>();
  readonly reservations = new Map<string, Reservation>();

  /** Amount currently counted against a scope: open reservations plus settled spend. */
  committed(scopeKey: string): MicroUsd {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (!r.firstResult.ok || !r.scopes.includes(scopeKey)) continue;
      total += r.settledMicroUsd ?? r.reservedMicroUsd;
    }
    return total;
  }

  async reserve(req: BudgetReservationRequest): Promise<BudgetReservationResult> {
    const existing = this.reservations.get(req.reservationId);
    if (existing) {
      return existing.firstResult.ok ? { ...existing.firstResult, replayed: true } : existing.firstResult;
    }
    if (!Number.isInteger(req.amountMicroUsd) || req.amountMicroUsd <= 0) throw new Error("reservation amount must be a positive integer");
    for (const s of req.scopes) if (!this.caps.has(s.key)) this.caps.set(s.key, s.capMicroUsd);

    let result: BudgetReservationResult = { ok: true, reservationId: req.reservationId, replayed: false };
    for (const s of req.scopes) {
      const cap = this.caps.get(s.key)!;
      const available = cap - this.committed(s.key);
      if (available < req.amountMicroUsd) {
        result = { ok: false, reservationId: req.reservationId, exhaustedScope: s.key, capMicroUsd: cap, availableMicroUsd: Math.max(0, available) };
        break;
      }
    }
    // A refused reservation is not stored, so a later retry (after budget is raised) can succeed.
    if (result.ok) {
      this.reservations.set(req.reservationId, {
        id: req.reservationId,
        jobId: req.jobId,
        scopes: req.scopes.map((s) => s.key),
        reservedMicroUsd: req.amountMicroUsd,
        settledMicroUsd: null,
        firstResult: result,
      });
    }
    return result;
  }

  async settle(reservationId: string, consumedMicroUsd: MicroUsd) {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error(`unknown reservation ${reservationId}`);
    if (r.settledMicroUsd !== null) return { settledMicroUsd: r.settledMicroUsd, replayed: true };
    r.settledMicroUsd = consumedMicroUsd;
    return { settledMicroUsd: consumedMicroUsd, replayed: false };
  }
}
