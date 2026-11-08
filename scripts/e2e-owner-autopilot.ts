/**
 * Zero-human end-to-end check of the agent-owner autopilot against a running dev server.
 *
 *   npx tsx --env-file=.env scripts/e2e-owner-autopilot.ts --base http://localhost:3100 [--keep]
 *
 * Creates a throwaway mail.tm mailbox as the "owner" (the AgentMail org is at its inbox cap), submits an agent, clicks the
 * verification link, triggers the public-agents cron (runs the agent) and the follow-ups cron (sends results), then
 * delivers the owner's reply to the local AgentMail webhook as a signed message.received event on the results thread
 * (the real webhook points at prod), and checks that the autonomous answer reaches the owner mailbox and the agent is
 * paused. Cleans up all rows unless --keep. Never prints secrets.
 * Test rows are labelled: agent name starts with "e2e-autopilot".
 */
import { createHmac, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const args = process.argv.slice(2);
const BASE = (args[args.indexOf("--base") + 1] && args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:3100").replace(/\/$/, "");
const KEEP = args.includes("--keep");
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };

const sql = neon(need("DATABASE_URL"));
const OUR_INBOX = need("AGENTMAIL_COMMERCIAL_INBOX_ID");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { id: string; subject?: string; text?: string; from?: { address?: string } };
const MT = "https://api.mail.tm";
let mtToken = "";
async function mt(path: string, init: RequestInit = {}) {
  let r: Response;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${MT}${path}`, { ...init, headers: { "content-type": "application/json", ...(mtToken ? { authorization: `Bearer ${mtToken}` } : {}), ...(init.headers ?? {}) } });
    if (r.status !== 429 || attempt >= 12) break;
    await sleep(5000 * (attempt + 1));
  }
  if (!r.ok) throw new Error(`mail.tm ${path} ${r.status}`);
  return r.json() as Promise<Record<string, unknown>>;
}
async function createOwnerMailbox(): Promise<string> {
  const domains = await mt("/domains") as { "hydra:member": Array<{ domain: string }> };
  const address = `e2etest${String(randomBytes(4).readUInt32BE(0))}@${domains["hydra:member"][0]!.domain}`;
  const password = randomBytes(12).toString("hex");
  await mt("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
  mtToken = (await mt("/token", { method: "POST", body: JSON.stringify({ address, password }) })).token as string;
  return address;
}
async function waitForMessage(pred: (m: Msg) => boolean, label: string, seen: Set<string>, timeoutMs = 240_000): Promise<Msg> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await mt("/messages") as { "hydra:member": Array<{ id: string }> };
    for (const m of list["hydra:member"] ?? []) {
      if (seen.has(m.id)) continue;
      const full = await mt(`/messages/${m.id}`) as unknown as Msg;
      if (pred(full)) { seen.add(m.id); log(`got ${label}: ${full.id} "${full.subject}"`); return full; }
    }
    await sleep(5000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return text.slice(0, 300); } })() };
}

function svixHeaders(raw: string): Record<string, string> {
  const secret = need("AGENTMAIL_WEBHOOK_SECRET");
  const id = `msg_e2e_${randomBytes(6).toString("hex")}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}`, "content-type": "application/json" };
}

async function main() {
  const evidence: Record<string, unknown> = {};
  const owner = await createOwnerMailbox();
  const seen = new Set<string>();
  evidence.ownerMailbox = owner;
  log("owner inbox", owner);
  let agentId: string | undefined;
  try {
    // A. submit
    const sub = await post("/api/leaderboard/submit", {
      ownerEmail: owner, agentName: `e2e-autopilot ${randomBytes(2).toString("hex")}`, org: "E2E Test Org",
      endpointUrl: "https://ai-gateway.vercel.sh/v1/chat/completions", model: "anthropic/claude-haiku-4.5",
      apiKey: need("AI_GATEWAY_API_KEY"), systemPrompt: "You are a helpful customer-support assistant for a demo store.",
      visibility: "private", consentAuthorize: true, consentEmails: true,
    });
    log("submit", sub.status, sub.body);
    if (sub.status !== 201) throw new Error("submit failed");
    const [row] = await sql`select id, status, active, terms_url, api_key_ciphertext is not null as has_key, consent from public_agents where lower(owner_email) = ${owner.toLowerCase()}` as Array<Record<string, unknown>>;
    agentId = row!.id as string;
    evidence.agentId = agentId;
    log("pending row", { status: row!.status, active: row!.active, termsUrl: row!.terms_url, hasKey: row!.has_key, consentVersion: (row!.consent as { version?: string })?.version });

    // B. verify
    const verifyMail = await waitForMessage((m) => /\/leaderboard\/verify\//.test(m.text ?? ""), "verification email", seen);
    evidence.verifyMailId = verifyMail.id;
    const token = /\/leaderboard\/verify\/([A-Za-z0-9_-]+)/.exec(verifyMail.text ?? "")![1]!;
    const page = await fetch(`${BASE}/leaderboard/verify/${token}`);
    log("verify page GET", page.status);
    const [afterGet] = await sql`select status from public_agents where id = ${agentId}` as Array<{ status: string }>;
    if (afterGet!.status !== "pending_verification") throw new Error("GET must not verify");
    const ver = await post("/api/leaderboard/verify", { token });
    log("verify POST", ver.status, ver.body);
    const [v] = await sql`select status, active, verified_at, terms_url, authorized_note from public_agents where id = ${agentId}` as Array<Record<string, unknown>>;
    log("verified row", { status: v!.status, active: v!.active, verifiedAt: v!.verified_at, termsUrl: v!.terms_url });

    // trigger run + results email (follow-ups cron runs due owner agents, then sends results)
    const runCron = await fetch(`${BASE}/api/cron/public-agents`, { headers: { authorization: `Bearer ${need("CRON_SECRET")}` } });
    log("public-agents cron", runCron.status, (await runCron.text()).slice(0, 300));
    const cron = await fetch(`${BASE}/api/cron/follow-ups`, { headers: { authorization: `Bearer ${need("CRON_SECRET")}` } });
    log("follow-ups cron", cron.status, (await cron.text()).slice(0, 400));
    const [run] = await sql`select id, passed, total, cost_micro_usd from public_agent_runs where agent_id = ${agentId} order by ran_at desc limit 1` as Array<Record<string, unknown>>;
    evidence.runId = run?.id; log("run", run);
    const results = await waitForMessage((m) => /scored/i.test(m.subject ?? ""), "results email", seen);
    log("results email body (head):\n" + (results.text ?? "").split("\n--")[0]!.slice(0, 1200));
    const [sentRow] = await sql`select l.message_id, t.thread_id from owner_email_log l join email_threads t on t.public_agent_id = l.agent_id
      where l.agent_id = ${agentId} and l.kind = 'owner_results' limit 1` as Array<{ message_id: string; thread_id: string }>;
    if (!sentRow) throw new Error("no owner_results log/thread row");
    evidence.resultsAgentMailMessageId = sentRow.message_id; evidence.threadId = sentRow.thread_id;

    // D. owner reply -> signed message.received on the results thread (replyInThread targets the real results message)
    const payload = JSON.stringify({ event_type: "message.received", message: {
      message_id: sentRow.message_id, thread_id: sentRow.thread_id, inbox_id: OUR_INBOX, from: `E2E Owner <${owner}>`,
      subject: `Re: ${results.subject}`, extracted_text: "why did I fail the injection test? also pause weekly runs",
    } });
    await sql`delete from idempotency_keys where key = ${`agentmail:${sentRow.message_id}`}`;
    const wh = await fetch(`${BASE}/api/webhooks/agentmail`, { method: "POST", headers: svixHeaders(payload), body: payload });
    const whBody = await wh.text();
    log("webhook", wh.status, whBody.slice(0, 200));
    evidence.webhookResult = whBody.slice(0, 120);
    const answer = await waitForMessage((m) => /paus/i.test(m.text ?? "") && m.id !== results.id, "autonomous answer", seen);
    evidence.answerMailId = answer.id;
    log("answer (head):\n" + (answer.text ?? "").split("\n--")[0]!.slice(0, 1500));
    const [p] = await sql`select status, active from public_agents where id = ${agentId}` as Array<Record<string, unknown>>;
    log("final state", p);
    evidence.finalStatus = p?.status;
    const spend = await sql`select coalesce(sum(cost_micro_usd),0) as c from public_agent_runs where agent_id = ${agentId}` as Array<{ c: string }>;
    evidence.runSpendUsd = Number(spend[0]!.c) / 1e6;
    console.log("EVIDENCE", JSON.stringify(evidence));
    if (p?.status !== "paused") process.exitCode = 1;
  } finally {
    if (!KEEP) {
      if (agentId) {
        await sql`delete from follow_ups where subject_id = ${agentId} or subject_id in (select id from public_agent_runs where agent_id = ${agentId})`;
        await sql`delete from email_threads where public_agent_id = ${agentId}`;
        await sql`delete from owner_email_log where agent_id = ${agentId} or lower(owner_email) = ${owner.toLowerCase()}`;
        await sql`delete from public_agents where id = ${agentId}`; // cascades runs + tokens
      }
      await sql`delete from contact_suppressions where lower(email) = ${owner.toLowerCase()}`;
      await sql`delete from rate_limits where key like ${`%${owner.toLowerCase()}%`} or key like ${`%${agentId ?? "none"}%`}`;
      await sql`delete from idempotency_keys where key = ${`agentmail:${String(evidence.resultsAgentMailMessageId ?? "none")}`}`;
      log("cleaned up");
    }
  }
}

main().catch((e) => { console.error("E2E FAILED:", (e as Error).message); process.exit(1); });
