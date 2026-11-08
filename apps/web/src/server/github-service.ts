import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { decrypt, encrypt } from "@ae/core/storage/crypto";
import { Finding, Remediation } from "@ae/core/contracts/index";
const { githubPrs, jobGithubTargets } = schema;
import { GithubError, PatchError, openPullRequest, redact, verifyAccess, type GithubTarget } from "./github-pr";
import { getJob } from "./job-store";
import { getCurrentCustomer } from "./queries";
import { jsonError } from "./http";

const GRACE_MS = 24 * 3600_000;

/** Owner only (operators included get 404). Returns the job or a ready 401/404 Response. */
export async function authorizeOwner(jobId: string) {
  const me = await getCurrentCustomer();
  if (!me) return { res: jsonError(401, "Authentication required") } as const;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return { res: jsonError(404, "Job not found") } as const;
  const job = await getJob(jobId);
  if (!job || job.customerId !== me.id) return { res: jsonError(404, "Job not found") } as const;
  return { me, job } as const;
}

export async function connectRepo(
  job: { id: string; credentialsDeleteAfter: Date | null },
  input: GithubTarget & { token: string },
): Promise<void> {
  await verifyAccess({ token: input.token }, input);
  const now = Date.now();
  const deadline = job.credentialsDeleteAfter?.getTime();
  const tokenExpiresAt = new Date(deadline && deadline > now ? deadline : now + GRACE_MS);
  const row = {
    owner: input.owner, repo: input.repo, baseBranch: input.baseBranch, filePath: input.filePath,
    tokenCiphertext: encrypt(input.token), tokenExpiresAt,
  };
  await db().insert(jobGithubTargets).values({ jobId: job.id, ...row })
    .onConflictDoUpdate({ target: jobGithubTargets.jobId, set: row });
}

export async function getConnection(jobId: string) {
  const [t] = await db().select().from(jobGithubTargets).where(eq(jobGithubTargets.jobId, jobId)).limit(1);
  if (!t || t.tokenExpiresAt.getTime() < Date.now()) return null;
  return t;
}

export async function disconnectRepo(jobId: string) {
  await db().delete(jobGithubTargets).where(eq(jobGithubTargets.jobId, jobId));
}

/** Public view: never includes the token. */
export async function connectionStatus(jobId: string) {
  const t = await getConnection(jobId);
  const prs = await db().select().from(githubPrs).where(eq(githubPrs.jobId, jobId));
  return {
    connected: !!t,
    ...(t ? { owner: t.owner, repo: t.repo, baseBranch: t.baseBranch, filePath: t.filePath, tokenExpiresAt: t.tokenExpiresAt.toISOString() } : {}),
    prs: Object.fromEntries(prs.map((p) => [p.remediationId, p.prUrl])),
  };
}

export type OpenPrOutcome = { status: number; body: { prUrl: string } | { error: string } };

export async function openRemediationPr(jobId: string, remediationId: string, origin: string): Promise<OpenPrOutcome> {
  const [rem] = await db().select().from(schema.remediations)
    .where(and(eq(schema.remediations.id, remediationId), eq(schema.remediations.jobId, jobId))).limit(1);
  if (!rem) return { status: 404, body: { error: "Remediation not found" } };
  const data = Remediation.safeParse(rem.data);
  if (!data.success) return { status: 409, body: { error: "Remediation is malformed" } };
  const r = data.data;
  if (r.verification.status === "not_verified") return { status: 409, body: { error: "Only verified or partially verified fixes can be shipped" } };

  const [prev] = await db().select().from(githubPrs).where(eq(githubPrs.remediationId, remediationId)).limit(1);
  if (prev) return { status: 200, body: { prUrl: prev.prUrl } };

  const conn = await getConnection(jobId);
  if (!conn) return { status: 409, body: { error: "Connect a GitHub repository first (or the saved token expired)" } };
  const [fr] = await db().select().from(schema.findings).where(eq(schema.findings.id, rem.findingRowId)).limit(1);
  const finding = Finding.safeParse(fr?.data);
  if (!finding.success) return { status: 409, body: { error: "Finding not found" } };

  let token = "";
  try {
    token = decrypt(conn.tokenCiphertext);
    const out = await openPullRequest({
      token, remediation: r, reportUrl: `${origin}/jobs/${jobId}`,
      target: { owner: conn.owner, repo: conn.repo, baseBranch: conn.baseBranch, filePath: conn.filePath },
      finding: { title: finding.data.title, severity: finding.data.severity, evidence: finding.data.evidence },
    });
    await db().insert(githubPrs).values({ jobId, remediationId, branch: out.branch, prNumber: out.prNumber, prUrl: out.prUrl })
      .onConflictDoNothing();
    return { status: out.created ? 201 : 200, body: { prUrl: out.prUrl } };
  } catch (err) {
    return mapError(err, token);
  }
}

export function mapError(err: unknown, token: string): OpenPrOutcome {
  if (err instanceof PatchError) return { status: 422, body: { error: `Patch could not be applied: ${redact(err.message, token)}` } };
  if (err instanceof GithubError) {
    const s = err.status;
    const msg = s === 401 ? "GitHub rejected the token (expired or revoked)"
      : s === 403 ? "The token lacks permission (needs contents:write and pull_requests:write on this repo)"
      : s === 404 ? "Repository, branch or file not found, or the token has no access to it"
      : `GitHub error: ${redact(err.message, token)}`;
    return { status: s === 401 || s === 403 || s === 404 ? 422 : 502, body: { error: msg } };
  }
  console.error("github pr failed", redact(err instanceof Error ? err.message : String(err), token));
  return { status: 500, body: { error: "Could not open the pull request" } };
}
