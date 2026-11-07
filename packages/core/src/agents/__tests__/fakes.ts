/**
 * FIXTURE test doubles. Passing tests that use these prove engine logic only; they are not live
 * Naïve SDK validation (see agents/live-diagnostic.ts for that).
 */
import {
  type AgentDirectory,
  type Clock,
  type JobRef,
  NaiveCallError,
  type NaiveSessionCreateBody,
  type NaiveSessionSnapshot,
  type NaiveSessionsPort,
} from "../../evals/types";
import { AgentSessionService, type AgentSessionServiceDeps } from "../session-service";
import { InMemoryAgentTaskStore, InMemoryBudgetLedger } from "../memory-ports";

export const directory: AgentDirectory = {
  commercial: { agentId: "agt_fake_commercial" },
  evaluation_engineer: { agentId: "agt_fake_engineer" },
  quality_investigator: { agentId: "agt_fake_investigator" },
  company_operator: { agentId: "agt_fake_operator" },
};

export const fixtureJob = (over: Partial<JobRef> = {}): JobRef => ({
  jobId: "job-fixture-1",
  customerId: "fixture-customer",
  package: "trace_audit",
  environment: "test",
  quoteVersion: null,
  linkedRetestOf: null,
  isFixture: true,
  ...over,
});

export class ManualClock implements Clock {
  constructor(public t = Date.parse("2026-11-07T20:00:00Z")) {}
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

/** What the fake server does with the session after creation. */
export type Script = (body: NaiveSessionCreateBody, callIndex: number) => Partial<NaiveSessionSnapshot> & { pollsUntilDone?: number };

/**
 * A fake Naïve API with the documented idempotency semantics:
 * same key + same body replays the original session; same key + different body is a conflict.
 */
export class FakeNaive implements NaiveSessionsPort {
  sessions = new Map<string, NaiveSessionSnapshot & { pollsLeft: number }>();
  byKey = new Map<string, { id: string; body: string }>();
  createCalls: Array<{ key: string; body: NaiveSessionCreateBody }> = [];
  getCalls = 0;
  /** Inject a failure for the N-th create call (0-based). `createdAnyway` = server created it but the client saw an error. */
  createFailures = new Map<number, { error: NaiveCallError; createdAnyway?: boolean }>();
  listFailure: NaiveCallError | null = null;
  private seq = 0;

  constructor(private script: Script = () => ({})) {}

  setScript(s: Script) {
    this.script = s;
  }

  private make(body: NaiveSessionCreateBody, idx: number): NaiveSessionSnapshot & { pollsLeft: number } {
    const s = this.script(body, idx);
    const id = `ses_fake_${++this.seq}`;
    return {
      id,
      agentId: body.agent_id,
      agentVersion: 1,
      status: "idle",
      stopReason: "end_turn",
      stopCode: null,
      structuredOutput: null,
      budgetMicroUsd: body.budget_micro_usd,
      consumedMicroUsd: 12_345,
      tokenUsage: { input: 100, output: 50 },
      metadata: { ...body.metadata },
      ...s,
      pollsLeft: s.pollsUntilDone ?? 0,
    };
  }

  async createSession(body: NaiveSessionCreateBody, key: string): Promise<NaiveSessionSnapshot> {
    const idx = this.createCalls.length;
    this.createCalls.push({ key, body: structuredClone(body) });
    const serialized = JSON.stringify(body);
    const failure = this.createFailures.get(idx);
    const prior = this.byKey.get(key);
    if (prior && prior.body !== serialized) throw new NaiveCallError("in_flight", "idempotency_conflict", 409, "idempotency_conflict");
    if (failure && !failure.createdAnyway) throw failure.error;
    let session = prior ? this.sessions.get(prior.id)! : null;
    if (!session) {
      session = this.make(body, idx);
      this.sessions.set(session.id, session);
      this.byKey.set(key, { id: session.id, body: serialized });
    }
    if (failure) throw failure.error;
    return this.view(session, true);
  }

  private view(s: NaiveSessionSnapshot & { pollsLeft: number }, atCreate = false): NaiveSessionSnapshot {
    const { pollsLeft, ...rest } = s;
    if (atCreate || pollsLeft > 0) return { ...rest, status: "running", stopReason: null, structuredOutput: null };
    return rest;
  }

  async getSession(id: string): Promise<NaiveSessionSnapshot> {
    this.getCalls++;
    const s = this.sessions.get(id);
    if (!s) throw new NaiveCallError("definitive", "not found", 404, "not_found");
    const v = this.view(s);
    if (s.pollsLeft > 0) s.pollsLeft--;
    return v;
  }

  async listAgentSessions(agentId: string, page: { after?: string; limit: number }) {
    if (this.listFailure) throw this.listFailure;
    const all = [...this.sessions.values()].filter((s) => s.agentId === agentId).reverse();
    const start = page.after ? all.findIndex((s) => s.id === page.after) + 1 : 0;
    const data = all.slice(start, start + page.limit).map((s) => this.view(s));
    return { data, nextCursor: start + page.limit < all.length ? data.at(-1)!.id : null };
  }

  /** Simulate a second session with the same task key (e.g. created out of band). */
  injectDuplicate(body: NaiveSessionCreateBody) {
    const s = this.make(body, -1);
    this.sessions.set(s.id, s);
  }
}

export function harness(script?: Script, over: Partial<AgentSessionServiceDeps> = {}) {
  const naive = new FakeNaive(script);
  const store = new InMemoryAgentTaskStore();
  const ledger = new InMemoryBudgetLedger();
  const clock = new ManualClock();
  const deps: AgentSessionServiceDeps = {
    naive,
    store,
    ledger,
    directory,
    budgetPeriodId: "2026-11-hackathon",
    idempotencyNamespace: "test",
    workerId: "worker-a",
    clock,
    sleep: async (ms) => clock.advance(ms),
    maxWaitMs: 60_000,
    pollIntervalMs: 1_000,
    ...over,
  };
  return { naive, store, ledger, clock, deps, service: new AgentSessionService(deps) };
}
