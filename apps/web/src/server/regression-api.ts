import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MONITORING_RUN_BUDGET_MICRO_USD, Suite } from "@ae/core/contracts/index";
import { readJobArtifactText } from "@ae/core/storage/blob";
import { verifyApiKey } from "./api-keys";
import { getJobForViewer } from "./queries";
import { getJobWithDecryptedCredentials, makeServiceContext } from "./job-store";
import { getEvalServices } from "./services";
import { rateLimit } from "./rate-limit";
import { assertPublicTarget } from "./target-url";
import { targetFromIntake } from "./monitoring";
import { evaluateRegression, redactSecret, targetKeyFromHeader, type RegressionInputs, type RegressionVerdict } from "./regression-check";
import { sqlRegressionStore, type RegressionRunRecord, type RegressionRunStore } from "./regression-store";

export const REGRESSION_RATE_LIMIT = 20;
export const REGRESSION_RATE_WINDOW_SEC = 600;
/** Respond synchronously if the run finishes inside this window, else hand back a runId to poll. */
export const REGRESSION_SYNC_MS = 50_000;
const MAX_BODY_BYTES = 8_192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOCK_TARGET = { url: "https://mock-target.example/v1", model: "mock-model", systemPrompt: "" };

const Body = z.object({
  jobId: z.uuid(),
  targetUrl: z.string().max(2_000).optional(),
  model: z.string().min(1).max(200).optional(),
});

export interface RegressionDeps {
  store: RegressionRunStore;
  /** Keep a promise alive after the response is sent (Next's `after`). */
  defer: (p: Promise<unknown>) => void;
  syncMs: number;
}

const json = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

async function authenticate(req: Request, scope: string) {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const key = await verifyApiKey(bearer);
  if (!key) return { err: json(401, { error: "Unauthorized: send your API key as 'Authorization: Bearer <key>'" }, { "WWW-Authenticate": "Bearer" }) };
  // Per customer, not per key: minting more API keys must not multiply the limit.
  const rl = await rateLimit(`${scope}:customer:${key.customerId}`, REGRESSION_RATE_LIMIT, REGRESSION_RATE_WINDOW_SEC);
  if (!rl.ok) return { err: json(429, { error: "rate_limited" }, { "Retry-After": String(rl.retryAfter) }) };
  return { key };
}

interface Prepared { run: () => Promise<RegressionVerdict>; secret: string | undefined }

/** Everything that can be rejected up front (400/409), then a closure that does the paid work. */
async function prepare(
  key: { customerId: string; email: string }, input: z.infer<typeof Body>, targetKey: string | undefined,
): Promise<Prepared | Response> {
  const data = await getJobForViewer(input.jobId, { id: key.customerId, email: key.email, isOperator: false });
  if (!data) return json(404, { error: "Job not found" });
  const full = await getJobWithDecryptedCredentials(input.jobId);
  if (!full || !full.job.suiteBlobPath) return json(409, { error: "This job has no frozen suite to re-run" });
  if (full.job.package === "trace_audit") return json(409, { error: "Trace audits have no frozen suite" });

  const text = await readJobArtifactText(full.job.suiteBlobPath);
  if (text === null) return json(409, { error: "Frozen suite is unavailable" });
  const suite = Suite.parse(JSON.parse(text));

  const original = targetFromIntake(full.intake);
  const isMock = full.job.isMock;
  const base = original ?? (isMock ? MOCK_TARGET : null);
  const url = input.targetUrl ?? base?.url;
  if (!url) return json(400, { error: "targetUrl is required: this job has no stored endpoint" });
  // Mock jobs never leave the process, so only an explicit URL needs the SSRF check.
  if (!isMock || input.targetUrl) {
    const reason = await assertPublicTarget(url);
    if (reason) return json(400, { error: `targetUrl rejected: ${reason}` });
  }
  const model = input.model ?? base?.model ?? MOCK_TARGET.model;
  // Never forward the stored key to a different host than the one it was issued for.
  const apiKey = targetKey ?? (input.targetUrl ? undefined : original?.apiKey);
  const target = { url, model, apiKey, systemPrompt: base?.systemPrompt ?? "" };

  return {
    secret: targetKey,
    run: async () => {
      const ctx = { ...(await makeServiceContext(input.jobId)), budgetMicroUsd: MONITORING_RUN_BUDGET_MICRO_USD };
      const result = await (await getEvalServices()).runSuite(ctx, suite, target);
      return evaluateRegression({ scenarios: suite.scenarios, results: result.results, findings: data.findings as RegressionInputs["findings"], remediations: data.remediations });
    },
  };
}

/** POST /api/v1/regression-runs */
export async function handleCreateRegressionRun(req: Request, deps: Partial<RegressionDeps> & Pick<RegressionDeps, "defer">): Promise<Response> {
  const d: RegressionDeps = { store: sqlRegressionStore, syncMs: REGRESSION_SYNC_MS, ...deps };
  const auth = await authenticate(req, "regression");
  if (auth.err) return auth.err;
  const { key } = auth;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "Request body too large" });
  let parsed: z.infer<typeof Body>;
  try { parsed = Body.parse(JSON.parse(raw)); } catch { return json(400, { error: "Body must be JSON: {jobId, targetUrl?, model?}" }); }

  const prep = await prepare(key, parsed, targetKeyFromHeader(req.headers.get("x-target-authorization")));
  if (prep instanceof Response) return prep;

  const rec: RegressionRunRecord = { runId: randomUUID(), jobId: parsed.jobId, customerId: key.customerId, status: "running", createdAt: new Date().toISOString() };
  await d.store.save(rec);

  const work = prep.run().then(
    async (result) => { await d.store.save({ ...rec, status: "completed", result }); return { result } as const; },
    async (err: unknown) => {
      const error = redactSecret(err instanceof Error ? err.message : "run failed", prep.secret).slice(0, 500);
      console.error("regression run failed", rec.runId, error);
      await d.store.save({ ...rec, status: "failed", error });
      return { error } as const;
    },
  );
  const timeout = new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), d.syncMs); t.unref?.(); });
  const done = await Promise.race([work, timeout]);
  if (!done) {
    d.defer(work);
    return json(202, { runId: rec.runId, status: "running" });
  }
  if ("error" in done) return json(502, { runId: rec.runId, status: "failed", error: done.error });
  return json(200, { runId: rec.runId, status: "completed", ...done.result });
}

/** GET /api/v1/regression-runs/:runId (owner only; 404 otherwise). */
export async function handleGetRegressionRun(req: Request, runId: string, deps: Partial<Pick<RegressionDeps, "store">> = {}): Promise<Response> {
  const store = deps.store ?? sqlRegressionStore;
  const auth = await authenticate(req, "regression-poll");
  if (auth.err) return auth.err;
  if (!UUID.test(runId)) return json(404, { error: "Run not found" });
  const rec = await store.get(runId);
  if (!rec || rec.customerId !== auth.key.customerId) return json(404, { error: "Run not found" });
  if (rec.status === "running") return json(200, { runId, status: "running" });
  if (rec.status === "failed") return json(200, { runId, status: "failed", error: rec.error ?? "run failed" });
  return json(200, { runId, status: "completed", ...rec.result });
}
