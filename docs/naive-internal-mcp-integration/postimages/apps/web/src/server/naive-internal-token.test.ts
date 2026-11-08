import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mintTaskToken, verifyTaskToken } from "./naive-internal-token";
import type { InternalTask } from "./naive-internal-store";
const secret = "s".repeat(32), audience = "https://example.test/api/mcp/internal/mcp";
const now = Math.floor(Date.now() / 1000);
const task: InternalTask = { id: "00000000-0000-4000-8000-000000000001", requestId: "00000000-0000-4000-8000-000000000002", customerId: "00000000-0000-4000-8000-000000000003", jobId: "00000000-0000-4000-8000-000000000004", credentialId: "00000000-0000-4000-8000-000000000005", agentId: "copilot-v1", agentVersion: 1, role: "copilot", environment: "test", nonce: Buffer.alloc(32, 7).toString("base64url"), issuedAt: now, expiresAt: now + 300 };
function sign(value: unknown) {
 const payload = Buffer.from(JSON.stringify({v:1,aud:audience,task:value})).toString("base64url");
 const body = `naive-internal-task.v1.${payload}`;
 return `${body}.${createHmac("sha256",secret).update(body).digest("base64url")}`;
}
describe("internal task tokens", () => {
 it("round trips the exact task and binds audience and secret", () => {
  const token = mintTaskToken(task, secret, audience);
  expect(verifyTaskToken(token, secret, audience, now)).toEqual(task);
  expect(() => verifyTaskToken(token, secret, audience.replace("example", "other"), now)).toThrow("Invalid task token");
  expect(() => verifyTaskToken(token, "x".repeat(32), audience, now)).toThrow();
 });
 it.each([{...task,expiresAt:now+301},{...task,issuedAt:now+1},{...task,expiresAt:now},{...task,extra:"no"},{...task,nonce:"a".repeat(43)},{...task,jobId:"bad"},{...task,role:"operator"},{...task,environment:"prod"}])("rejects malformed signed claims", value => expect(() => verifyTaskToken(sign(value),secret,audience,now)).toThrow());
 it("rejects expiry, tampering, padding, short keys, and wrong route audiences", () => {
  const token=mintTaskToken(task,secret,audience);
  for(const value of [token+"=", token.replace("v1", "v2"), token.slice(0,-2)]) expect(() => verifyTaskToken(value,secret,audience,now)).toThrow();
  expect(() => verifyTaskToken(token,secret,audience,now+300)).toThrow();
  expect(() => mintTaskToken(task,"short",audience)).toThrow();
  expect(() => mintTaskToken(task,secret,"https://example.test/api/mcp/mcp")).toThrow();
 });
});
