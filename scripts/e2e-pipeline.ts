/**
 * Live pipeline E2E against a running dev server (mock eval services, local Workflow World):
 *   npx tsx scripts/e2e-pipeline.ts --base http://localhost:3100
 * Signs in (magic-link dev flow), creates a trace_audit job from the fixture, waits for the quote,
 * simulates payment through the DEV-ONLY route (twice, plus once after delivery), waits for delivery and
 * verifies stored evidence. Exits non-zero on any failed check. The target server needs AUTH_DEV_LINKS=1,
 * DEV_SIMULATE_PAYMENTS=1 and NODE_ENV=development (next dev). Checks that read the DB use apps/web/.env.local.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(resolve(ROOT, "apps/web/.env.local"));
loadEnv(resolve(ROOT, ".env"));

const argBase = process.argv.indexOf("--base");
const BASE = (argBase > 0 ? process.argv[argBase + 1] : process.env.E2E_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const CUSTOMER_EMAIL = "e2e-pipeline@example.com";
const OPERATOR_EMAIL = (process.env.OPERATOR_EMAILS ?? "").split(",")[0]?.trim().toLowerCase();
const POLL_MS = 1500;
// Per-run fake client IP (TEST-NET-1) so repeated runs do not exhaust the local per-IP rate limits.
const FAKE_IP = `192.0.2.${1 + Math.floor(Math.random() * 253)}`;
const XFF = { "x-forwarded-for": FAKE_IP };

interface Check { name: string; ok: boolean; evidence: string }
const checks: Check[] = [];
function check(name: string, ok: boolean, evidence: string): void {
  checks.push({ name, ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${evidence}`);
}

class Session {
  private cookie = "";
  constructor(readonly email: string) {}

  async signIn(): Promise<void> {
    const rl = await fetch(`${BASE}/api/auth/request-link`, { method: "POST", headers: { "content-type": "application/json", ...XFF }, body: JSON.stringify({ email: this.email }) });
    const { devLink } = (await rl.json()) as { devLink?: string };
    if (!rl.ok || !devLink) throw new Error(`request-link failed (${rl.status}); is AUTH_DEV_LINKS=1 set?`);
    // devLink is built from APP_URL (may point at another port); take only the token and re-base onto the server under test.
    const token = new URL(devLink, BASE).searchParams.get("token");
    if (!token) throw new Error("devLink has no token");
    // GET /api/auth/verify must only redirect to the confirm page and never consume the token.
    const hop = await fetch(`${BASE}/api/auth/verify?token=${encodeURIComponent(token)}`, { redirect: "manual" });
    const loc = hop.headers.get("location");
    if (hop.status !== 303 || !loc?.includes("/signin/confirm")) throw new Error(`verify GET did not redirect to /signin/confirm (${hop.status} ${loc})`);
    const page = await fetch(`${BASE}/signin/confirm?token=${encodeURIComponent(token)}`);
    if (!page.ok) throw new Error(`/signin/confirm returned ${page.status}`);
    const v = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    if (!v.ok) throw new Error(`verify failed: ${v.status} ${await v.text()}`);
    const setCookie = v.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (!setCookie) throw new Error("verify set no session cookie");
    this.cookie = setCookie;
  }

  req(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${BASE}${path}`, { ...init, headers: { ...XFF, ...(init.headers as Record<string, string>), cookie: this.cookie } });
  }
  async json<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const r = await this.req(path, init);
    return { status: r.status, body: (await r.json().catch(() => null)) as T };
  }
}

async function pollState(s: Session, jobId: string, want: string[], timeoutMs: number): Promise<string> {
  const end = Date.now() + timeoutMs;
  let state = "?";
  while (Date.now() < end) {
    const { status, body } = await s.json<{ state: string; error?: string }>(`/api/jobs/${jobId}/progress`);
    if (status !== 200) throw new Error(`progress returned ${status}`);
    state = body.state;
    if (want.includes(state)) return state;
    if (["failed", "cancelled", "declined", "paused_budget"].includes(state)) throw new Error(`job reached ${state}: ${body.error ?? ""}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out waiting for ${want.join("/")} (last state ${state})`);
}

async function main(): Promise<void> {
  if (!OPERATOR_EMAIL) throw new Error("OPERATOR_EMAILS not set (needed for the dev simulate-payment route)");
  const { db, schema } = await import("../packages/core/src/db/client");
  const d = db();

  // 1. Sign in as customer and operator.
  const customer = new Session(CUSTOMER_EMAIL);
  const operator = new Session(OPERATOR_EMAIL);
  await customer.signIn();
  await operator.signIn();
  const me = await customer.json<{ jobs: unknown[] }>("/api/jobs");
  check("sign-in (GET link -> confirm page -> POST verify -> cookie)", me.status === 200, `customer ${CUSTOMER_EMAIL}, GET /api/jobs=${me.status}`);

  // 2. Create the job (and prove Idempotency-Key replays).
  const trace = readFileSync(resolve(ROOT, "e2e/fixtures/trace-unsupported-claim.json"), "utf8");
  const idem = `e2e-pipeline-${randomUUID()}`;
  const post = () => customer.json<{ jobId: string }>("/api/jobs", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": idem },
    body: JSON.stringify({ package: "trace_audit", trace, authorizedToTest: true }),
  });
  const created = await post();
  const jobId = created.body?.jobId;
  check("create trace_audit job", created.status === 201 && !!jobId, `status ${created.status} jobId ${jobId}`);
  if (!jobId) throw new Error("no job id");
  const replay = await post();
  check("job create is idempotent", replay.body?.jobId === jobId, `replay status ${replay.status} same id=${replay.body?.jobId === jobId}`);

  // 3. Quote.
  await pollState(customer, jobId, ["quoted"], 60_000);
  const quoted = await customer.json<{ quotes: { version: number; priceCents: number }[]; job: { isMock: boolean; environment: string } }>(`/api/jobs/${jobId}`);
  const q = quoted.body.quotes.at(-1)!;
  check("job reaches quoted with a quote", !!q, `quote v${q?.version} ${q?.priceCents}c, isMock=${quoted.body.job.isMock}, env=${quoted.body.job.environment}`);

  // 4. Simulate payment (twice), wait for delivery.
  const sim = () => operator.json<{ ok?: boolean; paymentId?: string; inserted?: boolean; outcome?: string }>("/api/dev/simulate-payment", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId }),
  });
  const s1 = await sim();
  check("simulate payment #1 records and resumes", s1.status === 200 && s1.body.inserted === true && s1.body.outcome === "resumed", JSON.stringify(s1.body));
  const s2 = await sim();
  check("simulate payment #2 is a no-op", s2.status === 200 && s2.body.inserted === false && s2.body.outcome === "already_resumed" && s2.body.paymentId === s1.body.paymentId, JSON.stringify(s2.body));

  await pollState(customer, jobId, ["delivered"], 120_000);
  check("job reaches delivered", true, "state=delivered");
  const s3 = await sim();
  check("simulate payment after delivery is a no-op", s3.status === 200 && s3.body.inserted === false && s3.body.outcome === "already_resumed", JSON.stringify(s3.body));

  // 5. Evidence.
  const full = await customer.json<any>(`/api/jobs/${jobId}`);
  const findings = (full.body.findings as { rerunOfFindingId?: string | null }[]).filter((f) => !f.rerunOfFindingId);
  check("findings saved", findings.length >= 1, `${findings.length} finding(s)`);
  check("remediations present", full.body.remediations.length >= 1, `${full.body.remediations.length} remediation(s), status ${full.body.remediations[0]?.verification?.status}`);
  check("report summary loaded", !!full.body.report?.markdown?.includes("Validated fixes"), `summary="${full.body.report?.summary}"`);

  const art = await customer.req(`/api/jobs/${jobId}/artifacts/report`);
  const artBody = await art.text();
  check("report artifact downloadable", art.status === 200 && artBody.length > 50, `status ${art.status}, ${artBody.length} bytes, ${art.headers.get("content-type")}`);
  const other = new Session("e2e-pipeline-other@example.com");
  await other.signIn();
  const denied = await other.req(`/api/jobs/${jobId}/artifacts/report`);
  check("other customer cannot read artifact (404)", denied.status === 404, `status ${denied.status}`);

  const progress = full.body.progress as { milestone: string }[];
  const count = (m: string) => progress.filter((p) => p.milestone === m).length;
  const milestones = progress.map((p) => p.milestone);
  const ordered = ["received", "awaiting_payment", "payment_confirmed", "auditing", "delivered"];
  const idx = ordered.map((m) => milestones.indexOf(m));
  check("progress timeline complete and ordered", idx.every((i, k) => i >= 0 && (k === 0 || i > idx[k - 1])), milestones.join(" > "));
  check("no duplicate workflow progress", count("payment_confirmed") === 1 && count("delivered") === 1 && count("payment_ignored") === 0,
    `payment_confirmed=${count("payment_confirmed")} delivered=${count("delivered")} payment_ignored=${count("payment_ignored")}`);

  const payRows = await d.select().from(schema.payments).where(eq(schema.payments.jobId, jobId));
  const p = payRows[0];
  check("exactly one payments row (paid, test)", payRows.length === 1 && p.status === "paid" && p.environment === "test" && p.amountCents === q.priceCents && p.stripeCheckoutSessionId === `cs_test_sim_${jobId}` && !!p.workflowResumedAt,
    `rows=${payRows.length} status=${p?.status} env=${p?.environment} amount=${p?.amountCents} resumed=${!!p?.workflowResumedAt}`);
  const intv = await d.select({ n: sql<number>`count(*)::int` }).from(schema.interventions).where(eq(schema.interventions.jobId, jobId));
  check("no stranded-payment interventions", intv[0].n === 0, `interventions=${intv[0].n}`);

  const [job] = await d.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  check("delivered_at / credentials_delete_after / branch_delete_after set", !!job.deliveredAt && !!job.credentialsDeleteAfter && !!job.branchDeleteAfter,
    `delivered=${job.deliveredAt?.toISOString()} creds=${job.credentialsDeleteAfter?.toISOString()} branch=${job.branchDeleteAfter?.toISOString()}`);
  check("report_blob_path stored", !!job.reportBlobPath, `${job.reportBlobPath}`);

  const resv = await d.select().from(schema.budgetReservations).where(eq(schema.budgetReservations.jobId, jobId));
  check("budget reservations released", resv.length >= 1 && resv.every((r) => r.releasedAt), `${resv.length} reservation(s), ${resv.filter((r) => r.releasedAt).length} released`);
  const costs = await d.select({ n: sql<number>`count(*)::int`, sum: sql<number>`coalesce(sum(micro_usd),0)::bigint` }).from(schema.costs).where(eq(schema.costs.jobId, jobId));
  check("cost rows recorded (mock services record none; real ones must)", job.isMock ? costs[0].n >= 0 : costs[0].n >= 1, `rows=${costs[0].n} total=${costs[0].sum} microUSD`);

  // 6. Clarification path: marker in notes -> needs_clarification -> answer -> quoted.
  const cl = await customer.json<{ jobId: string }>("/api/jobs", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": `e2e-clarify-${randomUUID()}` },
    body: JSON.stringify({ package: "trace_audit", trace, notes: "[needs-clarification]", authorizedToTest: true }),
  });
  const clId = cl.body?.jobId;
  check("create clarification job", cl.status === 201 && !!clId, `status ${cl.status} jobId ${clId}`);
  if (clId) {
    const st = await pollState(customer, clId, ["needs_clarification", "quoted"], 60_000);
    check("job enters needs_clarification", st === "needs_clarification", `state=${st}`);
    const ans = await customer.json(`/api/jobs/${clId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "Focus on unsupported success claims." }),
    });
    check("clarification answer accepted", ans.status === 201, `status ${ans.status}`);
    const after = await pollState(customer, clId, ["quoted"], 60_000);
    check("job reaches quoted after answer", after === "quoted", `state=${after}`);
  }

  console.log(`\nJOB_ID=${jobId}`);
}

main().then(() => {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}).catch((err) => {
  console.error(`\nFATAL: ${err instanceof Error ? err.message : err}`, err instanceof Error && err.cause ? err.cause : "");
  process.exit(1);
});
