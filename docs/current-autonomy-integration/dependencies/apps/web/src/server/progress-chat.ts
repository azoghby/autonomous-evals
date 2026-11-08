import "server-only";
import { readStructuredProgress } from "./structured-progress";
import { createHmac } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { decrypt, decryptJson } from "@ae/core/storage/crypto";
import { containsSecret } from "@ae/core/agents/redact";
import { createProgressChatService, createPostgresConversationPort, ChatError,
  ProgressSnapshotSchema, type ProgressSnapshot, type ConversationSqlExecutor,
  type ConversationTransactionalSql } from "@ae/core/reporting/chat/index";
import { getCurrentCustomer } from "./session";

// Same DATABASE_URL/schema and Neon WS driver as core integration/eval-services.
// That module's pool is private: own a small lazy pool rather than changing core ownership.
let pool: Pool | undefined;
function database(): Pool {
  if (!process.env.DATABASE_URL) throw new ChatError("storage_error");
  return pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 3,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
}

export async function pinned<T>(pool: Pick<Pool, "connect">, readOnly: boolean,
  run: (tx: ConversationSqlExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const result = await run({ query: async <R>(sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params); return { rows: result.rows as R[] };
    } });
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

type Job = { id: string; customer_id: string; state: string; updated_at: Date | string };
type Timed = { id: string; created_at: Date | string };
type Progress = Timed & { milestone: string };
type Finding = Timed & { status: string; severity: string };
type Cost = Timed & { source: string; micro_usd: string | number };
const iso = (value: Date | string) => new Date(value).toISOString();

/** Only enum/count/cost fields enter the projection. No intake, trace, report, error,
 * finding prose, event message, cost metadata or provider/session IDs are selected. */
export function mapSnapshot(job: Job, progress: Progress[], findings: Finding[], costs: Cost[], key: Buffer,
  subjectId: string): ProgressSnapshot {
  if (progress.length > 200 || findings.length > 200 || costs.length > 1000) throw new ChatError("invalid_snapshot");
  const ref = (kind: string, id: string) => "ev_" + createHmac("sha256", key)
    .update(JSON.stringify(["private-progress-chat-v1", subjectId, job.id, kind, id])).digest("hex");
  const observedAt = [job.updated_at, ...progress.map(r => r.created_at), ...findings.map(r => r.created_at),
    ...costs.map(r => r.created_at)].map(iso).sort().at(-1)!;
  const value = {
    jobId: job.id, observedAt, status: job.state, statusEvidenceRef: ref("status", job.state + iso(job.updated_at)),
    milestones: progress.map(row => ({ id: ref("progress", row.id),
      milestone: ["planning", "running", "investigating", "delivered"].includes(row.milestone) ? row.milestone : "other",
      at: iso(row.created_at), evidenceRef: ref("progress", row.id) })),
    findings: findings.map(row => ({ id: ref("finding", row.id), status: row.status, severity: row.severity,
      evidenceRefs: [ref("finding", row.id)] })),
    blockers: ["paused_budget", "payment_review", "needs_clarification", "failed"].includes(job.state)
      ? [{ id: ref("blocker", job.state), kind: job.state === "paused_budget" ? "budget" :
        job.state === "payment_review" ? "payment" : job.state === "needs_clarification" ? "input" : "other",
        evidenceRef: ref("status", job.state + iso(job.updated_at)) }] : [],
    costs: costs.map(row => ({ id: ref("cost", row.id), source: row.source, microUsd: Number(row.micro_usd),
      evidenceRef: ref("cost", row.id) })),
    // App cost rows have no completeness marker, including at delivery. Never imply zero total.
    unknownCosts: true,
  };
  const parsed = ProgressSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new ChatError("invalid_snapshot");
  return parsed.data;
}

function secretsFrom(value: unknown): string[] {
  if (typeof value === "string") return value.length >= 4 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(secretsFrom);
  if (value && typeof value === "object") return Object.values(value).flatMap(secretsFrom);
  return [];
}

/** Per-request session, authorization and current credentials. No client identity or global injectable service. */
export async function progressChatForRequest(jobId: string) {
  const me = await getCurrentCustomer();
  if (!me) throw new ChatError("unauthenticated");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw new ChatError("not_found");
  const p = database();
  const material = await pinned(p, true, async tx => {
    const jobs = await tx.query<Job>("SELECT id, customer_id, state, updated_at FROM jobs WHERE id = $1 AND (customer_id = $2 OR $3::boolean)", [jobId, me.id, me.isOperator]);
    const job = jobs.rows[0];
    if (!job) throw new ChatError("not_found");
    // Decrypt credentials only after authorization, inside the same snapshot. No provider/blob reads.
    const credentials = await tx.query<{ciphertext: string}>("SELECT ciphertext FROM job_credentials WHERE job_id = $1", [jobId]);
    const github = await tx.query<{token_ciphertext: string}>("SELECT token_ciphertext FROM job_github_targets WHERE job_id = $1", [jobId]);
    const knownSecrets = Object.entries(process.env).filter(([name]) => /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL/i.test(name))
      .flatMap(([, value]) => secretsFrom(value));
    for (const row of credentials.rows) knownSecrets.push(...secretsFrom(decryptJson(row.ciphertext)));
    for (const row of github.rows) knownSecrets.push(...secretsFrom(decrypt(row.token_ciphertext)));
    const key = Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY ?? "", "base64");
    if (key.length !== 32) throw new ChatError("invalid_snapshot");
    const events = await tx.query<Progress>("SELECT id, milestone, created_at FROM progress_events WHERE job_id = $1 ORDER BY created_at, id LIMIT 201", [jobId]);
    const findings = await tx.query<Finding>("SELECT id, data->>'status' AS status, data->>'severity' AS severity, created_at FROM findings WHERE job_id = $1 AND rerun_of_finding_id IS NULL ORDER BY created_at, id LIMIT 201", [jobId]);
    const costs = await tx.query<Cost>("SELECT id, source, micro_usd, created_at FROM costs WHERE job_id = $1 ORDER BY created_at, id LIMIT 1001", [jobId]);
    const appSnapshot = mapSnapshot(job, events.rows, findings.rows, costs.rows, key, me.id);
    const structured = await readStructuredProgress(tx, { subjectId: me.id, jobId }, job, key, knownSecrets, appSnapshot.observedAt);
    const snapshot = structured ? { ...structured, blockers: [...structured.blockers, ...appSnapshot.blockers], costs: appSnapshot.costs, unknownCosts: true } : appSnapshot;
    if (containsSecret(JSON.stringify(snapshot), knownSecrets)) throw new ChatError("invalid_snapshot");
    return { snapshot, knownSecrets };
  });
  const sql: ConversationTransactionalSql = {
    query: async <R>(query: string, params?: unknown[]) => {
      const result = await p.query(query, params); return { rows: result.rows as R[] };
    },
    transaction: run => pinned(p, false, run),
  };
  return createProgressChatService({
    access: {
      authenticate: async () => ({ subjectId: me.id }),
      resolveAuthorizedJob: async (caller, id) => {
        const result = await p.query("SELECT id FROM jobs WHERE id = $1 AND (customer_id = $2 OR $3::boolean)", [id, caller.subjectId, me.isOperator]);
        return result.rows.length === 1 ? { subjectId: caller.subjectId, jobId: id } : null;
      },
    },
    progress: { read: async () => material.snapshot },
    conversations: createPostgresConversationPort(sql), knownSecrets: material.knownSecrets,
  });
}
