import { and, eq, notInArray, desc, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { TERMINAL_SESSION_STATUSES, type AgentSessionRecord, type AgentSessionStore } from "../contracts/services";

type Row = typeof schema.agentSessions.$inferSelect;

const toRecord = (r: Row): AgentSessionRecord => ({
  id: r.id, jobId: r.jobId, agent: r.agent, agentId: r.agentId, agentVersion: r.agentVersion,
  sessionId: r.sessionId, status: r.status, decision: r.decision, result: r.result, usageMicroUsd: r.usageMicroUsd,
});

export function createSessionStore(jobId: string): AgentSessionStore {
  const mine = (sessionId: string) => and(eq(schema.agentSessions.jobId, jobId), eq(schema.agentSessions.sessionId, sessionId));
  return {
    async start({ agent, agentId, agentVersion, sessionId }) {
      const [inserted] = await db().insert(schema.agentSessions)
        .values({ jobId, agent, agentId: agentId ?? null, agentVersion: agentVersion ?? null, sessionId })
        .onConflictDoNothing({ target: schema.agentSessions.sessionId })
        .returning();
      if (inserted) return toRecord(inserted);
      const [existing] = await db().select().from(schema.agentSessions).where(mine(sessionId)).limit(1);
      if (!existing) throw new Error(`Session ${sessionId} already belongs to another job`);
      return toRecord(existing);
    },
    async update(sessionId, patch) {
      const add = patch.addUsageMicroUsd;
      if (add !== undefined && (!Number.isInteger(add) || add < 0)) throw new Error("addUsageMicroUsd must be a non-negative integer");
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.decision !== undefined) set.decision = patch.decision;
      if (patch.result !== undefined) set.result = patch.result;
      if (add) set.usageMicroUsd = sql`${schema.agentSessions.usageMicroUsd} + ${add}`;
      const [row] = await db().update(schema.agentSessions).set(set).where(mine(sessionId)).returning();
      return row ? toRecord(row) : null;
    },
    async findResumable(agent) {
      const [row] = await db().select().from(schema.agentSessions)
        .where(and(
          eq(schema.agentSessions.jobId, jobId), eq(schema.agentSessions.agent, agent),
          notInArray(schema.agentSessions.status, [...TERMINAL_SESSION_STATUSES]),
        ))
        .orderBy(desc(schema.agentSessions.createdAt)).limit(1);
      return row ? toRecord(row) : null;
    },
  };
}
