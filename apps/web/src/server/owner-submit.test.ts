import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SESSION_SECRET = "test-secret";
  process.env.APP_URL = "https://app.test";
  const state = {
    batches: [] as Array<Array<{ kind: string; table: string; values?: Record<string, unknown>; set?: Record<string, unknown> }>>,
    claim: [] as unknown[], // rows returned by the token-claim update
    tokenRow: undefined as unknown, // row returned by the post-miss token lookup
    agentRow: undefined as Record<string, unknown> | undefined, // select on publicAgents
  };
  const table = (name: string) => new Proxy({ __t: name }, { get: (t, k) => (k === "__t" ? t.__t : `${name}.${String(k)}`) });
  const op = (kind: string, tbl: { __t: string }) => {
    const o: Record<string, unknown> = { kind, table: tbl.__t };
    const self: Record<string, unknown> = new Proxy({}, {
      get(_t, k) {
        if (k === "__data") return o;
        if (k === "values") return (v: unknown) => { o.values = v; return self; };
        if (k === "set") return (v: unknown) => { o.set = v; return self; };
        if (k === "then") return undefined;
        return () => self;
      },
    });
    return self;
  };
  return { state, table, op };
});

vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: () => ({}), gt: () => ({}), isNull: () => ({}), sql: () => ({}) }));
vi.mock("@ae/core/db/client", () => {
  const schema = Object.fromEntries(["publicAgents", "publicAgentTokens", "contactSuppressions"].map((n) => [n, h.table(n)]));
  return {
    schema,
    db: () => ({
      insert: (t: { __t: string }) => h.op("insert", t),
      delete: (t: { __t: string }) => h.op("delete", t),
      update: (t: { __t: string }) => {
        if (t.__t === "publicAgentTokens") {
          // the standalone claim: awaited directly via .returning()
          const chain: Record<string, unknown> = {
            set: () => chain, where: () => chain,
            returning: () => Promise.resolve(h.state.claim),
          };
          return chain;
        }
        return h.op("update", t);
      },
      select: () => ({
        from: (t: { __t: string }) => {
          const rows = () => (t.__t === "publicAgentTokens" ? (h.state.tokenRow ? [h.state.tokenRow] : []) : (h.state.agentRow ? [h.state.agentRow] : []));
          const chain: Record<string, unknown> = { where: () => chain, limit: () => Promise.resolve(rows()) };
          return chain;
        },
      }),
      batch: async (ops: Array<{ __data: { kind: string; table: string; values?: Record<string, unknown>; set?: Record<string, unknown> } }>) => {
        const data = ops.map((o) => o.__data);
        h.state.batches.push(data);
        // mimic the DB: an update ... returning() yields the row with the new values applied
        return data.map((d) => (d.kind === "update" ? [{ ...h.state.agentRow, ...d.set }] : []));
      },
    }),
  };
});
const sendEmail = vi.fn(async (_m: unknown) => ({ id: "m1", threadId: null }));
vi.mock("@ae/core/auth/email", () => ({ isEmailConfigured: () => true, sendEmail: (m: unknown) => sendEmail(m) }));
const recordOwnerEmail = vi.fn(async (_i: unknown) => undefined);
vi.mock("./owner-shared", () => ({
  appUrl: () => "https://app.test", footerFor: (n: string) => `--FOOTER ${n}`, recordOwnerEmail: (i: unknown) => recordOwnerEmail(i),
}));

import { SubmitAgentInput, createPendingSubmission, makeSlug, verifySubmission } from "./owner-submit";
import { SLUG_RE } from "./leaderboard";
import { assertAuthorizedToTest } from "./leaderboard-agents";
import { CONSENT_VERSION, OWNER_KEY_SENTINEL, OWNER_TERMS_URL } from "./owner-policy";
import { hashToken } from "@ae/core/auth/tokens";

const NOW = new Date("2026-06-10T12:00:00Z");
const valid = {
  ownerEmail: "Owner@Example.com", agentName: "My Agent!", org: "Acme", endpointUrl: "https://api.acme.test/v1/chat/completions",
  model: "acme-1", apiKey: "sk-super-secret-key", visibility: "public", consentAuthorize: true, consentEmails: true,
};

beforeEach(() => {
  h.state.batches = []; h.state.claim = []; h.state.tokenRow = undefined; h.state.agentRow = undefined;
  sendEmail.mockClear(); recordOwnerEmail.mockClear();
});

describe("SubmitAgentInput", () => {
  it("accepts a valid submission", () => expect(SubmitAgentInput.safeParse(valid).success).toBe(true));
  it("rejects missing or false consent", () => {
    expect(SubmitAgentInput.safeParse({ ...valid, consentAuthorize: false }).success).toBe(false);
    expect(SubmitAgentInput.safeParse({ ...valid, consentEmails: false }).success).toBe(false);
    const { consentEmails: _c, ...rest } = valid;
    expect(SubmitAgentInput.safeParse(rest).success).toBe(false);
  });
  it("rejects http endpoints and bad visibility", () => {
    expect(SubmitAgentInput.safeParse({ ...valid, endpointUrl: "http://api.acme.test/v1/chat/completions" }).success).toBe(false);
    expect(SubmitAgentInput.safeParse({ ...valid, visibility: "friends" }).success).toBe(false);
  });
  it("rejects over-long fields", () => {
    expect(SubmitAgentInput.safeParse({ ...valid, apiKey: "k".repeat(501) }).success).toBe(false);
    expect(SubmitAgentInput.safeParse({ ...valid, agentName: "" }).success).toBe(false);
  });
});

describe("makeSlug", () => {
  it("matches SLUG_RE with a 6 char suffix", () => {
    const s = makeSlug("My Agent!");
    expect(s).toMatch(SLUG_RE);
    expect(s).toMatch(/^my-agent-[a-z0-9]{6}$/);
  });
  it("handles names with no usable characters", () => expect(makeSlug("!!!")).toMatch(SLUG_RE));
});

describe("createPendingSubmission", () => {
  it("stores a pending, inactive, unauthorized agent with an encrypted key and hashed token", async () => {
    const r = await createPendingSubmission(SubmitAgentInput.parse(valid), { ip: "1.2.3.4", now: NOW });
    expect(h.state.batches).toHaveLength(1);
    const [agentOp, tokenOp] = h.state.batches[0]!;
    const a = agentOp!.values!;
    expect(a).toMatchObject({
      id: r.agentId, slug: r.slug, kind: "third_party", status: "pending_verification", active: false, termsUrl: null,
      authorizedNote: null, ownerEmail: "owner@example.com", authEnvVar: OWNER_KEY_SENTINEL, visibility: "public",
    });
    expect(() => assertAuthorizedToTest(a as never)).toThrow();
    expect(a.apiKeyCiphertext).toBeTruthy();
    expect(a.apiKeyCiphertext).not.toBe(valid.apiKey);
    expect(String(a.apiKeyCiphertext)).not.toContain("super-secret");
    expect((a.consent as { version: string; ipHash: string })).toMatchObject({ version: CONSENT_VERSION });
    expect(JSON.stringify(a.consent)).not.toContain("1.2.3.4");
    const t = tokenOp!.values!;
    expect(t.agentId).toBe(r.agentId);
    expect(t.purpose).toBe("verify");
    expect((t.expiresAt as Date).getTime()).toBe(NOW.getTime() + 48 * 3600_000);
    // email link token hashes to the stored hash; plaintext token never stored
    const sent = sendEmail.mock.calls[0]![0] as { text: string; purpose: string; to: string };
    const token = /verify\/(\S+)/.exec(sent.text)![1]!;
    expect(hashToken(token)).toBe(t.tokenHash);
    expect(t.tokenHash).not.toBe(token);
    expect(sent).toMatchObject({ purpose: "auth", to: "owner@example.com" });
    expect(sent.text).toContain("--FOOTER My Agent!");
    expect(recordOwnerEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: "owner_verify", transactional: true }));
  });

  it("stores no key material when apiKey is omitted", async () => {
    await createPendingSubmission(SubmitAgentInput.parse({ ...valid, apiKey: undefined }), { ip: "1.2.3.4", now: NOW });
    const a = h.state.batches[0]![0]!.values!;
    expect(a.apiKeyCiphertext).toBeNull();
    expect(a.authEnvVar).toBeNull();
  });

  it("still persists when the email transport fails", async () => {
    sendEmail.mockRejectedValueOnce(new Error("boom"));
    const r = await createPendingSubmission(SubmitAgentInput.parse(valid), { ip: "1.2.3.4", now: NOW });
    expect(r.emailSent).toBe(false);
    expect(h.state.batches).toHaveLength(1);
  });
});

describe("verifySubmission", () => {
  const TOKEN = "t".repeat(43);
  const pending = {
    id: "a1", slug: "my-agent-abc123", name: "My Agent", ownerEmail: "owner@example.com", visibility: "private",
    status: "pending_verification", active: false, authEnvVar: null,
    consent: { version: CONSENT_VERSION, acceptedAt: "2026-06-09T12:00:00.000Z", ipHash: "abcdef0123456789" },
  };

  it("activates the agent with authorization fields that satisfy assertAuthorizedToTest, and clears suppression", async () => {
    h.state.claim = [{ agentId: "a1" }];
    h.state.agentRow = pending;
    const r = await verifySubmission(TOKEN, NOW);
    expect(r).toEqual({ status: "ok", slug: "my-agent-abc123", visibility: "private", name: "My Agent" });
    const [upd, del] = h.state.batches[0]!;
    expect(upd).toMatchObject({ kind: "update", table: "publicAgents" });
    expect(del).toMatchObject({ kind: "delete", table: "contactSuppressions" });
    const s = upd!.set!;
    expect(s).toMatchObject({ status: "active", active: true, verifiedAt: NOW, termsUrl: OWNER_TERMS_URL });
    expect(String(s.authorizedNote)).toContain("o***r@example.com");
    expect(String(s.authorizedNote)).toContain(CONSENT_VERSION);
    expect(String(s.authorizedNote)).toContain("abcdef01");
    expect(String(s.authorizedNote)).not.toContain("owner@example.com");
    expect(String(s.authorizedNote).length).toBeLessThanOrEqual(1000);
    expect(() => assertAuthorizedToTest({ ...pending, ...s } as never)).not.toThrow();
  });

  it("reports a used token", async () => {
    h.state.tokenRow = { usedAt: NOW, expiresAt: new Date(NOW.getTime() + 1000) };
    expect(await verifySubmission(TOKEN, NOW)).toEqual({ status: "used" });
    expect(h.state.batches).toHaveLength(0);
  });
  it("reports an expired token", async () => {
    h.state.tokenRow = { usedAt: null, expiresAt: new Date(NOW.getTime() - 1000) };
    expect(await verifySubmission(TOKEN, NOW)).toEqual({ status: "expired" });
  });
  it("reports an unknown or malformed token as invalid", async () => {
    expect(await verifySubmission(TOKEN, NOW)).toEqual({ status: "invalid" });
    expect(await verifySubmission("short", NOW)).toEqual({ status: "invalid" });
  });
  it("does not activate an agent that is no longer pending", async () => {
    h.state.claim = [{ agentId: "a1" }];
    h.state.agentRow = { ...pending, status: "opted_out" };
    expect(await verifySubmission(TOKEN, NOW)).toEqual({ status: "invalid" });
    expect(h.state.batches).toHaveLength(0);
  });
});
