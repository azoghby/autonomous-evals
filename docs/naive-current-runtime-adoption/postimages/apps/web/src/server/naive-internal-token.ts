import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { InternalTask } from "./naive-internal-store";

const uuid = z.string().uuid();
const TaskSchema = z.object({
  id: uuid, requestId: uuid, customerId: uuid, jobId: uuid, credentialId: uuid,
  agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  agentVersion: z.number().int().positive().max(2147483647), environment: z.enum(["test", "live"]), role: z.literal("copilot"),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((s) => Buffer.from(s, "base64url").toString("base64url") === s),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).strict();
function configuration(secret: string, audience: string) {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Invalid task-token configuration");
  const url = new URL(audience);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/api/mcp/internal/mcp") throw new Error("Invalid task-token configuration");
}
function validate(task: unknown, now: number): InternalTask {
  const t = TaskSchema.parse(task);
  if (!Number.isSafeInteger(now) || t.expiresAt <= t.issuedAt || t.expiresAt - t.issuedAt > 300 || t.issuedAt > now || t.expiresAt <= now) throw new Error("Invalid task token");
  return t;
}
/** Task authorization only. This token makes no claim about a provider session. */
export function mintTaskToken(task: InternalTask, secret: string, audience: string): string {
  configuration(secret, audience);
  const value = validate(task, Math.floor(Date.now() / 1000));
  const payload = Buffer.from(JSON.stringify({ v: 1, aud: audience, task: value })).toString("base64url");
  const signed = `naive-internal-task.v1.${payload}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}
export function verifyTaskToken(raw: string, secret: string, audience: string, nowEpoch = Math.floor(Date.now() / 1000)): InternalTask {
  try {
    configuration(secret, audience);
    if (typeof raw !== "string" || raw.length > 4096) throw new Error();
    const parts = raw.split(".");
    if (parts.length !== 4 || parts[0] !== "naive-internal-task" || parts[1] !== "v1") throw new Error();
    const [, , payload, signature] = parts;
    if (![payload, signature].every((s) => /^[A-Za-z0-9_-]+$/.test(s) && Buffer.from(s, "base64url").toString("base64url") === s)) throw new Error();
    const expected = createHmac("sha256", secret).update(parts.slice(0, 3).join(".")).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const envelope = z.object({ v: z.literal(1), aud: z.literal(audience), task: TaskSchema }).strict().parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return validate(envelope.task, nowEpoch);
  } catch { throw new Error("Invalid task token"); }
}
