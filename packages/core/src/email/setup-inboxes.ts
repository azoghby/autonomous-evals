/**
 * One-off, idempotent: creates/gets the AgentMail inboxes and registers the inbound webhook.
 * Run from repo root: npx tsx packages/core/src/email/setup-inboxes.ts
 * Writes AGENTMAIL_*_INBOX_ID / AGENTMAIL_WEBHOOK_SECRET into .env and apps/web/.env.local (never prints secrets).
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { agentMailClient } from "./agentmail";

const WEBHOOK_URL = process.env.AGENTMAIL_WEBHOOK_URL ?? "https://autonomous-evals.vercel.app/api/webhooks/agentmail";
const ENV_FILES = [".env", "apps/web/.env.local"];

const INBOXES = [
  { env: "AGENTMAIL_COMMERCIAL_INBOX_ID", username: "ae-commercial", clientId: "ae-commercial", displayName: "Autonomous Evals" },
  { env: "AGENTMAIL_AUTH_INBOX_ID", username: "ae-auth", clientId: "ae-auth", displayName: "Autonomous Evals Sign-in" },
] as const;

function upsertEnv(file: string, name: string, value: string) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(file, re.test(text) ? text.replace(re, line) : `${text}${text.endsWith("\n") || !text ? "" : "\n"}${line}\n`);
}

async function findInbox(username: string, clientId: string) {
  const client = agentMailClient();
  let pageToken: string | undefined;
  do {
    const page = await client.inboxes.list({ limit: 100, ...(pageToken ? { pageToken } : {}) });
    const hit = page.inboxes.find((i) => i.clientId === clientId || i.email.split("@")[0] === username);
    if (hit) return hit;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return null;
}

async function main() {
  const client = agentMailClient();
  const ids: Record<string, string> = {};
  for (const spec of INBOXES) {
    let inbox = await findInbox(spec.username, spec.clientId);
    try {
      inbox ??= await client.inboxes.create({ username: spec.username, clientId: spec.clientId, displayName: spec.displayName });
    } catch (err) {
      // Plan inbox cap reached: never delete someone else's inbox; share the commercial one instead.
      if (!/limit_exceeded|Inbox limit/i.test(String((err as Error)?.message) + JSON.stringify((err as { body?: unknown })?.body ?? ""))) throw err;
      const shared = ids.AGENTMAIL_COMMERCIAL_INBOX_ID;
      if (!shared) throw err;
      console.warn(`${spec.env}: inbox limit reached, falling back to the commercial inbox ${shared}`);
      for (const f of ENV_FILES) upsertEnv(f, spec.env, shared);
      ids[spec.env] = shared;
      continue;
    }
    ids[spec.env] = inbox.inboxId;
    console.log(`${spec.env} -> ${inbox.inboxId} (${inbox.email})`);
    for (const f of ENV_FILES) upsertEnv(f, spec.env, inbox.inboxId);
  }

  const commercial = ids.AGENTMAIL_COMMERCIAL_INBOX_ID!;
  const existing = (await client.webhooks.list({ limit: 100 })).webhooks.find((w) => w.url === WEBHOOK_URL);
  const hook = existing ?? (await client.webhooks.create({
    url: WEBHOOK_URL, eventTypes: ["message.received"], inboxIds: [commercial], clientId: "ae-inbound",
  }));
  for (const f of ENV_FILES) upsertEnv(f, "AGENTMAIL_WEBHOOK_SECRET", hook.secret);
  console.log(`webhook ${existing ? "already registered" : "registered"}: ${hook.webhookId} -> ${WEBHOOK_URL} (secret stored in env files)`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
