import 'server-only';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { containsSecret } from '@ae/core/agents/redact';
import { canonicalJson } from '@ae/core/evals/text/index';
/** Rich evidence is retained in durable private application storage. No runtime DDL.
 * Callers authorize job ownership separately; scope is checked again in SQL. */
export async function persistRichArtifact(db: AgentTransactionalSql,
  scope: { jobId: string; tenantId: string; environment: 'test' | 'live' },
  suiteDigest: string, body: unknown, knownSecrets: readonly string[]) {
  const encoded = canonicalJson(body);
  if (!/^[a-f0-9]{64}$/.test(suiteDigest) || containsSecret(encoded, knownSecrets)) throw new Error('rich_evidence_refused');
  await db.transaction(async tx => {
    const job = (await tx.query<{ customer_id: string; environment: string }>(
      'SELECT customer_id, environment FROM jobs WHERE id=$1 FOR UPDATE', [scope.jobId])).rows[0];
    if (!job || job.customer_id !== scope.tenantId || job.environment !== scope.environment) throw new Error('rich_evidence_scope');
    const old = (await tx.query<{ suite_digest: string; body: unknown }>(
      'SELECT suite_digest, body FROM workflow_integration.rich_artifacts WHERE job_id=$1', [scope.jobId])).rows[0];
    if (old) {
      if (old.suite_digest !== suiteDigest || canonicalJson(old.body) !== encoded) throw new Error('rich_evidence_conflict');
      return;
    }
    await tx.query('INSERT INTO workflow_integration.rich_artifacts(job_id,tenant_id,environment,suite_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)',
      [scope.jobId, scope.tenantId, scope.environment, suiteDigest, encoded]);
  });
}
export async function readRichArtifact(db: AgentTransactionalSql, jobId: string, tenantId: string, knownSecrets: readonly string[]): Promise<unknown | null> {
  const row = (await db.query<{ body: unknown }>(`SELECT a.body FROM workflow_integration.rich_artifacts a
    JOIN jobs j ON j.id=a.job_id AND j.customer_id=a.tenant_id AND j.environment=a.environment
    WHERE a.job_id=$1 AND a.tenant_id=$2`, [jobId, tenantId])).rows[0];
  if (row && containsSecret(canonicalJson(row.body), knownSecrets)) throw new Error('rich_evidence_refused');
  return row?.body ?? null;
}
