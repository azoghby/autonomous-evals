import type { CostEntry } from "../evals/types";
import { PostgresAgentTaskStore, PostgresBudgetLedger, type AgentTransactionalSql } from "./postgres-ports";
import { AgentSessionService, type AgentSessionServiceDeps, type AgentTaskRunner } from "./session-service";

export interface AgentCostSink {
  /**
   * Atomically upsert by key. Repeated delivery must not add spend twice; reject a
   * changed amount/identity under the same key. Acknowledge only after durable commit.
   */
  record(key: string, entry: CostEntry): Promise<void>;
}

/**
 * Deliver every measured outcome, including schema failures and budget pauses.
 * Delivery failure blocks the caller. Retrying the SAME task reads its durable
 * result and redelivers the same cost, without another session or reservation.
 * No local "delivered" flag: it cannot be atomic with an external app ledger.
 */
export function withAgentCostDelivery(runner: AgentTaskRunner, sink: AgentCostSink): AgentTaskRunner {
  return {
    async run(spec) {
      const outcome = await runner.run(spec);
      if ("cost" in outcome && outcome.cost?.measured) {
        const cost = outcome.cost;
        if (!cost.externalId || !Number.isSafeInteger(cost.microUsd) || cost.microUsd < 0) {
          throw new Error("agent_cost_invalid");
        }
        await sink.record(`naive:${cost.externalId}`, structuredClone(cost));
      }
      return outcome;
    },
  };
}

/**
 * Server-side composition only: no environment reads, provisioning, migrations,
 * network calls or in-memory fallback. The caller supplies authorized configuration
 * and a pinned-connection SQL transaction port in application storage.
 */
export function createPostgresAgentRuntime(
  deps: Omit<AgentSessionServiceDeps, "store" | "ledger"> & {
    db: AgentTransactionalSql;
    costs: AgentCostSink;
  },
): AgentTaskRunner {
  const { db, costs, ...sessionDeps } = deps;
  return withAgentCostDelivery(new AgentSessionService({
    ...sessionDeps,
    store: new PostgresAgentTaskStore(db),
    ledger: new PostgresBudgetLedger(db),
  }), costs);
}
