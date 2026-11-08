import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { selects: [] as unknown[][], updateResult: [] as unknown[], suppressed: false, inserts: 0, updates: 0, configured: false };
  const chain = (result: () => unknown): unknown => new Proxy({}, {
    get: (_t, k) => k === "then" ? (res: (v: unknown) => unknown) => res(result()) : () => chain(result),
  });
  return { state, chain };
});
vi.mock("server-only", () => ({}));
// Legacy drafts bypass the SQL-managed operation boundary; managed SQL is exercised separately.
vi.mock("./automated-expert-owner", () => ({
  approveSqlManagedExpertDraft: async () => false,
  expertOwnerDatabase: () => ({ transaction: async (fn: (tx: { query: () => Promise<{ rows: unknown[] }> }) => unknown) => fn({ query: async () => ({ rows: [] }) }) }),
}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: () => ({}) }));
vi.mock("@ae/core/db/client", () => {
  const t = new Proxy({}, { get: (_x, k) => String(k) });
  return {
    schema: { outreachDrafts: t, interventions: t, expertEngagements: t, prospectLeads: t },
    db: () => ({
      select: () => h.chain(() => h.state.selects.shift() ?? []),
      update: () => h.chain(() => { h.state.updates++; return h.state.updateResult; }),
      insert: () => h.chain(() => { h.state.inserts++; return []; }),
    }),
  };
});
const sendEmail = vi.fn(async () => ({ id: "m", threadId: "t" }));
vi.mock("@ae/core/auth/email", () => ({ isEmailConfigured: () => h.state.configured, sendEmail: (m: unknown) => sendEmail(m as never) }));
vi.mock("@ae/core/email/agentmail", () => ({ isAgentMailConfigured: () => h.state.configured }));
const guard = vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; status: number; error: string });
vi.mock("./experts", () => ({ guardOutreachSend: (...a: unknown[]) => guard(...(a as [])) }));
vi.mock("./email-threads", () => ({ recordEmailThread: vi.fn(async () => undefined) }));
vi.mock("./owner-shared", () => ({ isSuppressed: async () => h.state.suppressed }));
vi.mock("./http", () => ({ isUuid: (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) }));

import { approveAndSendDraft, parseApproveAll } from "./outreach-approve";

const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  Object.assign(h.state, { selects: [], updateResult: [], suppressed: false, inserts: 0, updates: 0, configured: false });
  sendEmail.mockClear(); guard.mockClear();
  process.env.OPERATOR_EMAILS = "op@example.com";
});

describe("approveAndSendDraft", () => {
  it("refuses a suppressed agent_invite with 409 and never claims or sends", async () => {
    h.state.selects = [[{ toEmail: "a@b.com", kind: "agent_invite" }]]; h.state.suppressed = true; h.state.configured = true;
    const r = await approveAndSendDraft(ID, "op@example.com");
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(h.state.updates).toBe(0); expect(sendEmail).not.toHaveBeenCalled();
  });

  it("runs guardOutreachSend for expert drafts and propagates its refusal", async () => {
    h.state.selects = [[{ toEmail: "e@b.com", kind: "expert_invite" }]];
    guard.mockResolvedValueOnce({ ok: false, status: 429, error: "limit" });
    expect(await approveAndSendDraft(ID, "op@example.com")).toEqual({ ok: false, status: 429, error: "limit" });
    expect(h.state.updates).toBe(0);
  });

  it("returns 404 when the draft does not exist and 409 when already handled", async () => {
    expect(await approveAndSendDraft(ID, "op@example.com")).toMatchObject({ ok: false, status: 404 });
    h.state.selects = [[], [{ status: "sent" }]];
    expect(await approveAndSendDraft(ID, "op@example.com")).toMatchObject({ ok: false, status: 409 });
  });

  it("approves without sending when email is not configured; sends when configured", async () => {
    h.state.selects = [[{ toEmail: "e@b.com", kind: "expert_invite" }], []];
    h.state.updateResult = [{ toEmail: "e@b.com", subject: "s", body: "b" }];
    expect(await approveAndSendDraft(ID, "op@example.com")).toEqual({ ok: true, status: "approved" });
    expect(h.state.inserts).toBe(1); expect(sendEmail).not.toHaveBeenCalled();

    h.state.configured = true; h.state.selects = [[{ toEmail: "e@b.com", kind: "expert_invite" }], []];
    expect(await approveAndSendDraft(ID, "op@example.com")).toEqual({ ok: true, status: "sent" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("approveAndSendDraft resendApproved (idempotent retry)", () => {
  const approved = { status: "approved", toEmail: "e@b.com", subject: "s", body: "b", kind: "expert_invite" };

  it("re-sends an approved-but-unsent draft instead of returning 409", async () => {
    h.state.configured = true;
    h.state.selects = [[], [approved], []];
    expect(await approveAndSendDraft(ID, "op@example.com", { resendApproved: true })).toEqual({ ok: true, status: "sent" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(h.state.inserts).toBe(0); // no second approval intervention
  });

  it("returns ok without sending when the draft was already sent", async () => {
    h.state.configured = true;
    h.state.selects = [[], [{ ...approved, status: "sent" }]];
    expect(await approveAndSendDraft(ID, "op@example.com", { resendApproved: true })).toEqual({ ok: true, status: "sent" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("still refuses to re-send to a suppressed recipient", async () => {
    h.state.configured = true; h.state.suppressed = true;
    h.state.selects = [[], [approved]];
    expect(await approveAndSendDraft(ID, "op@example.com", { resendApproved: true })).toMatchObject({ ok: false, status: 409, draftStatus: "approved" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("without the option an approved draft is still a 409 carrying its status", async () => {
    h.state.selects = [[], [approved]];
    expect(await approveAndSendDraft(ID, "op@example.com")).toMatchObject({ ok: false, status: 409, draftStatus: "approved" });
  });
});

describe("sdr kinds", () => {
  it("still blocks a suppressed sdr_first_touch at approve time via guardOutreachSend", async () => {
    h.state.selects = [[{ toEmail: "p@b.com", kind: "sdr_first_touch" }]]; h.state.configured = true;
    guard.mockResolvedValueOnce({ ok: false, status: 409, error: "suppressed" });
    expect(await approveAndSendDraft(ID, "op@example.com")).toMatchObject({ ok: false, status: 409 });
    expect(guard).toHaveBeenCalledWith(ID, "p@b.com");
    expect(h.state.updates).toBe(0); expect(sendEmail).not.toHaveBeenCalled();
  });

  it("marks the lead contacted after an sdr send", async () => {
    h.state.configured = true;
    h.state.selects = [[{ toEmail: "p@b.com", kind: "sdr_first_touch" }], []];
    h.state.updateResult = [{ toEmail: "p@b.com", subject: "s", body: "b", kind: "sdr_first_touch" }];
    expect(await approveAndSendDraft(ID, "op@example.com")).toEqual({ ok: true, status: "sent" });
    expect(h.state.updates).toBe(3); // claim + sent status + lead contacted
  });
});

describe("parseApproveAll", () => {
  it("accepts a current operator and keeps only unique valid uuids", () => {
    expect(parseApproveAll({ op: "OP@example.com", ids: [ID, ID, "nope", 5] })).toEqual({ ids: [ID], op: "OP@example.com" });
  });
  it("rejects a non-operator, malformed payloads and null", () => {
    expect(parseApproveAll({ op: "x@example.com", ids: [ID] })).toBeNull();
    expect(parseApproveAll({ op: "op@example.com", ids: "x" })).toBeNull();
    expect(parseApproveAll(null)).toBeNull();
  });
});
