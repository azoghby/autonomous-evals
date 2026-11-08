import 'server-only';
import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { customerForSessionToken } from '@ae/core/auth/magic-link';
import { pooledCalendarDatabase } from '@ae/core/simulator/pool';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { getSessionToken } from './session';
import { authenticateCredential, authorizeTask, issueTask, revokeTask, audit, type ConfiguredPin, type InternalCredential } from './naive-internal-store';
import { mintTaskToken, verifyTaskToken } from './naive-internal-token';
import { readInternalProgress } from './naive-internal-progress';

const unavailable = (): never => { throw Error('internal_mcp_unavailable'); };
export interface InternalRuntimeConfig { pin: ConfiguredPin; secret: string; audience: string }
/** No defaults for activation, agent identity, origin or task signing key. */
export function internalRuntimeConfig(env: NodeJS.ProcessEnv = process.env): InternalRuntimeConfig {
  if (env.NAIVE_INTERNAL_MCP_ENABLED !== '1') return unavailable();
  const match = /^(agt_[0-9a-hjkmnp-tv-z]{26})@([1-9][0-9]*)$/.exec(env.NAIVE_AGENT_COPILOT ?? '');
  const version = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(version)) return unavailable();
  const secret = env.NAIVE_TASK_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) return unavailable();
  let origin: URL; try { origin = new URL(env.APP_URL ?? ''); } catch { return unavailable(); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)) return unavailable();
  return { pin: { agentId: match[1]!, agentVersion: version }, secret, audience: `${origin.origin}/api/mcp/internal/mcp` };
}
async function freshOwner() {
  const token = await getSessionToken();
  const customer = token ? await customerForSessionToken(token) : null;
  return customer?.id ?? null;
}
let database: AgentTransactionalSql | undefined;
function sql() {
  const connectionString = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
  if (!connectionString) return unavailable();
  return database ??= pooledCalendarDatabase(new Pool({ connectionString, max: 5 }));
}
/** Internal capabilities do not inherit the public limiter's fail-open behavior. */
export function failClosedInternalLimiter(db: AgentTransactionalSql) {
  return async (key: string, limit: number, windowSec: number) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowSec) || windowSec < 1) return unavailable();
    const row = (await db.query<{count:number|string;retry_after:number|string}>(`
      INSERT INTO rate_limits AS r(key,window_start,count) VALUES($1,now(),1)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN r.window_start<=now()-make_interval(secs=>$2::int) THEN 1 ELSE LEAST(r.count,$3::int)+1 END,
        window_start=CASE WHEN r.window_start<=now()-make_interval(secs=>$2::int) THEN now() ELSE r.window_start END
      RETURNING count,GREATEST(0,CEIL(EXTRACT(EPOCH FROM(window_start+make_interval(secs=>$2::int)-now()))))::int AS retry_after`, [key,windowSec,limit])).rows[0];
    const count=Number(row?.count), retry=Number(row?.retry_after);
    if (!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(retry)||retry<0) return unavailable();
    return {ok:count<=limit,retryAfter:count<=limit?0:Math.max(1,retry)};
  };
}
type DeniedReason = 'auth_denied' | 'rate_limited' | 'request_denied' | 'read_denied' | 'internal_error';
export function internalMcpDependencies(db: AgentTransactionalSql, config: InternalRuntimeConfig, limit = failClosedInternalLimiter(db)) {
  return {
    async authenticate(bearer: string): Promise<InternalCredential | null> {
      if (bearer.length < 32 || bearer.length > 1024 || /\s/.test(bearer)) return null;
      const digest = createHash('sha256').update(bearer).digest('hex');
      try { return await db.transaction(tx => authenticateCredential(tx, digest, config.pin)); }
      catch (error) { if (error instanceof Error && error.message === 'naive_internal_unauthorized') return null; throw error; }
    },
    async rateLimit(credential: InternalCredential) {
      return (await limit(`naive-internal:${credential.role}:${credential.agentId}`, 60, 600)).ok;
    },
    async read(credential: InternalCredential, input: { taskToken: string }) {
      const claims = verifyTaskToken(input.taskToken, config.secret, config.audience);
      return db.transaction(async tx => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await authorizeTask(tx, claims, credential, config.pin);
        const snapshot = await readInternalProgress(tx, { customerId: claims.customerId, jobId: claims.jobId });
        return snapshot;
      });
    },
    async auditDenied(reason: DeniedReason, credentialId?: string) {
      await db.transaction(tx => audit(tx, reason, { credentialId }));
    },
  };
}
/** Trusted application composition: no provider/session call is made by issuing a read capability. */
export function internalTaskDependencies(db: AgentTransactionalSql, config: InternalRuntimeConfig, currentOwner = freshOwner, limit = failClosedInternalLimiter(db)) {
  const auth = (expected: string) => async () => {
    if (await currentOwner() !== expected) return unavailable();
    return { customerId: expected };
  };
  return {
    currentOwner,
    async allowIssue(customerId: string) { return (await limit(`naive-internal-issue:${customerId}`, 20, 3600)).ok; },
    async issue(customerId: string, jobId: string, requestId: string) {
      return db.transaction(async tx => {
        const task = await issueTask(tx, { jobId, requestId }, auth(customerId), config.pin);
        const taskToken = mintTaskToken(task, config.secret, config.audience);
        return { taskId: task.id, taskToken, expiresAt: task.expiresAt };
      });
    },
    async revoke(customerId: string, jobId: string, taskId: string) {
      return db.transaction(async tx => {
        await revokeTask(tx, jobId, taskId, auth(customerId));
      });
    },
  };
}
export function createInternalMcpDependencies() { const config = internalRuntimeConfig(); return internalMcpDependencies(sql(), config); }
export function createInternalTaskDependencies() { const config = internalRuntimeConfig(); return internalTaskDependencies(sql(), config); }
