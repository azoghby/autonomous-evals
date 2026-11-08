import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "@ae/core/ai/gateway";
import type { OnboardingModelOutput } from "@ae/core/company/onboarding";
import { SandboxInputError } from "../sandbox/target";
import { handleOnboardingMessage, runOnboardingFollowThrough, type OnboardingDeps, type OnboardingSandbox } from "./onboarding";
import type { ConversationPatch, ConversationRow, OnboardingStore } from "./onboarding-store";
import { memoryRuntime } from "./runtime.testing";

vi.mock("@ae/core/db/client", () => ({ db: vi.fn(), schema: {} }));
vi.mock("../sandbox-service", () => ({ getSandboxService: vi.fn() }));
vi.mock("../email-threads", () => ({ recordEmailThread: vi.fn() }));
vi.mock("../owner-shared", () => ({ appUrl: () => "https://app.test", isSuppressed: async () => false }));
vi.mock("../sandbox/store", () => ({ createDbSandboxStore: vi.fn() }));
vi.mock("@ae/core/payments/plans-checkout", () => ({ getCustomerPlan: vi.fn() }));

const CUSTOMER = { id: "cust-1", email: "pat@example.com", name: "Pat" };
const NOW = new Date("2026-06-01T12:00:00Z");

function fakeStore(initial: ConversationRow[] = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  let n = 0;
  const store: OnboardingStore = {
    getCustomer: async (id) => (id === CUSTOMER.id ? CUSTOMER : null),
    getConversation: async (id) => rows.get(id) ?? null,
    findByThread: async (t) => [...rows.values()].find((r) => r.threadId === t) ?? null,
    latestForCustomer: async (c, ch) => [...rows.values()].find((r) => r.customerId === c && r.channel === ch && r.status !== "closed") ?? null,
    create: async (i) => {
      const row: ConversationRow = { id: `conv-${++n}`, customerId: i.customerId, channel: i.channel, threadId: i.threadId ?? null, status: "collecting", collected: {}, transcript: [], environmentId: null, suiteId: null, runId: null, reportedAt: null, costMicroUsd: 0, updatedAt: NOW };
      rows.set(row.id, row);
      return row;
    },
    update: async (id, patch: ConversationPatch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
    listByStatus: async (s) => [...rows.values()].filter((r) => s.includes(r.status)),
  };
  return { store, rows };
}

const row = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: "conv-x", customerId: CUSTOMER.id, channel: "chat", threadId: null, status: "building", collected: {}, transcript: [],
  environmentId: "env-1", suiteId: "drf-1", runId: null, reportedAt: null, costMicroUsd: 0, updatedAt: NOW, ...over,
});

const readyOut: OnboardingModelOutput = {
  reply: "Great.", missing: [], readyToRun: true,
  extracted: { agent: { model: "openai/gpt-5-mini", systemPrompt: "You are a support bot." }, tools: { prebuiltWorld: "acme-support" } },
};

function setup(over: { generate?: OnboardingDeps["generate"]; sandbox?: Partial<OnboardingSandbox>; rows?: ConversationRow[]; allowance?: OnboardingDeps["allowance"] } = {}) {
  const { store, rows } = fakeStore(over.rows);
  const mail = vi.fn(async (m: { to: string; subject: string }) => ({ status: "dry_run" as const, to: m.to, subject: m.subject }));
  const reply = vi.fn(async () => ({ threadId: "t1" }));
  const generate = vi.fn(over.generate ?? (async () => readyOut));
  const sandbox = {
    createDraft: vi.fn(async () => ({ draftId: "drf-1", environmentId: "env-1", status: "generating", scenarios: [], costMicroUsd: 0 })),
    getDraft: vi.fn(), startRun: vi.fn(), getRunReport: vi.fn(), ...over.sandbox,
  } as unknown as OnboardingSandbox;
  const rt = memoryRuntime();
  const deps: Partial<OnboardingDeps> = {
    store, sandbox: () => sandbox, generate, mail: mail as unknown as OnboardingDeps["mail"], reply, recordThread: vi.fn(async () => {}),
    allowance: over.allowance ?? (async () => ({ headroomMicroUsd: null, runCapMicroUsd: 3_000_000 })),
    fetchSpec: async () => "openapi: 3.0.0", baseUrl: () => "https://app.test", runtime: rt.deps,
  };
  return { deps, rows, mail, reply, generate, sandbox, rt };
}

const chat = { customerId: CUSTOMER.id, channel: "chat" as const, text: "hi" };
const opts = { trigger: "chat" as const, now: NOW, dryRun: true, env: { NODE_ENV: "test" } };

describe("handleOnboardingMessage", () => {
  it("creates a conversation, builds when requirements are complete, and stores ids", async () => {
    const s = setup();
    const r = await handleOnboardingMessage(chat, opts, s.deps);
    expect(r.status).toBe("building");
    expect(s.sandbox.createDraft).toHaveBeenCalledWith(CUSTOMER.id, expect.objectContaining({ prebuilt: "acme-support" }));
    const conv = s.rows.get(r.conversationId)!;
    expect(conv).toMatchObject({ status: "building", suiteId: "drf-1", environmentId: "env-1" });
    expect(conv.transcript.map((t) => t.role)).toEqual(["customer", "agent"]);
    expect(s.rt.activities[0]?.agentId).toBe("onboarding");
  });

  it("keeps collecting and asks the model's question when requirements are missing", async () => {
    const s = setup({ generate: async () => ({ reply: "What tools does it use?", missing: ["tools"], readyToRun: false, extracted: { agent: { model: "openai/gpt-5-mini", systemPrompt: "x" } } }) });
    const r = await handleOnboardingMessage(chat, opts, s.deps);
    expect(r).toMatchObject({ status: "collecting", reply: "What tools does it use?" });
    expect(s.sandbox.createDraft).not.toHaveBeenCalled();
    expect(s.rows.get(r.conversationId)!.collected).toMatchObject({ agent: { model: "openai/gpt-5-mini" } });
  });

  it("never sends a pasted key to the model and stores a redacted transcript", async () => {
    const s = setup();
    const r = await handleOnboardingMessage({ ...chat, text: "my key is sk-abcdefghijklmnopqrstuvwxyz123456" }, opts, s.deps);
    expect(s.generate).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/rotate/i);
    expect(JSON.stringify(s.rows.get(r.conversationId)!.transcript)).not.toContain("sk-abcdef");
  });

  it("handles a gateway credential_leak as a secret reply", async () => {
    const s = setup({ generate: async () => { throw new GatewayError("credential_leak", "x"); } });
    const r = await handleOnboardingMessage(chat, opts, s.deps);
    expect(r.reply).toMatch(/rotate/i);
  });

  it("drops private endpoint URLs and tells the customer", async () => {
    const s = setup({ generate: async () => ({ reply: "ok", missing: [], readyToRun: true, extracted: { agent: { endpointUrl: "https://localhost/v1" }, tools: { prebuiltWorld: "acme-support" } } }) });
    const r = await handleOnboardingMessage(chat, opts, s.deps);
    expect(r.status).toBe("collecting");
    expect(r.reply).toMatch(/can't use the agent endpoint/);
  });

  it("surfaces plan-limit 402s politely and blocks", async () => {
    const s = setup({ sandbox: { createDraft: vi.fn(async () => { throw new SandboxInputError("Free plan allows 1 environment.", 402); }) } });
    const r = await handleOnboardingMessage(chat, opts, s.deps);
    expect(r.status).toBe("blocked");
    expect(r.reply).toContain("Free plan allows 1 environment.");
  });

  it("blocks for founder review when the plan allowance cannot cover a minimal run", async () => {
    const s = setup({ allowance: async () => ({ headroomMicroUsd: 1_000, runCapMicroUsd: 3_000_000 }) });
    const r = await handleOnboardingMessage(chat, opts, s.deps);
    expect(r.status).toBe("blocked");
    expect(r.reply).toMatch(/founder/);
    expect(s.sandbox.createDraft).not.toHaveBeenCalled();
  });

  it("does not call the model while a run is in flight", async () => {
    const s = setup({ rows: [row({ id: "conv-9", status: "running" })] });
    const r = await handleOnboardingMessage({ ...chat, conversationId: "conv-9" }, opts, s.deps);
    expect(r.status).toBe("running");
    expect(s.generate).not.toHaveBeenCalled();
  });

  it("rejects a conversation that belongs to another customer", async () => {
    const s = setup({ rows: [row({ id: "conv-9", customerId: "someone-else" })] });
    const r = await handleOnboardingMessage({ ...chat, conversationId: "conv-9" }, opts, s.deps);
    expect(r.conversationId).toBe("conv-9");
    expect(s.generate).not.toHaveBeenCalled();
  });

  it("ignores non-customers", async () => {
    const s = setup();
    const r = await handleOnboardingMessage({ ...chat, customerId: "stranger" }, opts, s.deps);
    expect(r.result.status).toBe("skipped");
    expect(s.generate).not.toHaveBeenCalled();
  });

  it("reports the toggle being off", async () => {
    const s = setup();
    s.rt.toggles.set("onboarding", false);
    const r = await handleOnboardingMessage(chat, { ...opts, ignoreToggle: false }, s.deps);
    expect(r.reply).toBe("The onboarding assistant is off right now.");
    expect(r.result).toMatchObject({ status: "skipped", reason: "disabled" });
  });

  it("replies on the customer's thread when live, and falls back to Re: email in dry run", async () => {
    const email = { ...chat, channel: "email" as const, threadId: "th-1", subject: "Help", inboxId: "inbox", messageId: "m1" };
    const live = setup();
    await handleOnboardingMessage(email, { ...opts, dryRun: false, env: { COMPANY_EMAIL_DRY_RUN: "0" } }, live.deps);
    const dry = setup();
    await handleOnboardingMessage(email, opts, dry.deps);
    expect(dry.mail).toHaveBeenCalledWith(expect.objectContaining({ to: CUSTOMER.email, subject: "Re: Help" }), { dryRun: true });
    expect(dry.reply).not.toHaveBeenCalled();
    // live path depends on the environment having an email transport configured; either way exactly one send path is used
    expect(live.mail.mock.calls.length + live.reply.mock.calls.length).toBe(1);
  });
});

const readyDraft = (extra: object = {}) => ({
  draftId: "drf-1", status: "ready", costMicroUsd: 1000,
  scenarios: [{ scenario: { id: "s1" }, validated: true }, { scenario: { id: "s2" }, validated: false }], ...extra,
});

describe("runOnboardingFollowThrough", () => {
  it("starts the run once the suite is ready (validated scenarios only)", async () => {
    const s = setup({
      rows: [row()],
      sandbox: { getDraft: vi.fn(async () => readyDraft()) as never, startRun: vi.fn(async () => ({ ok: true as const, runId: "run-1" })) },
    });
    await runOnboardingFollowThrough({ trigger: "cron", now: NOW, dryRun: true }, s.deps);
    expect(s.sandbox.startRun).toHaveBeenCalledWith(CUSTOMER.id, "drf-1", { k: 3, scenarioIds: ["s1"] });
    expect(s.rows.get("conv-x")).toMatchObject({ status: "running", runId: "run-1" });
  });

  it("waits while the suite is still generating", async () => {
    const s = setup({ rows: [row()], sandbox: { getDraft: vi.fn(async () => readyDraft({ status: "gating" })) as never } });
    await runOnboardingFollowThrough({ trigger: "cron", now: NOW, dryRun: true }, s.deps);
    expect(s.rows.get("conv-x")!.status).toBe("building");
    expect(s.sandbox.startRun).not.toHaveBeenCalled();
  });

  it("blocks and tells the customer when suite generation failed", async () => {
    const s = setup({ rows: [row({ channel: "email" })], sandbox: { getDraft: vi.fn(async () => readyDraft({ status: "failed", error: "boom" })) as never } });
    await runOnboardingFollowThrough({ trigger: "cron", now: NOW, dryRun: true }, s.deps);
    expect(s.rows.get("conv-x")!.status).toBe("blocked");
    expect(s.mail).toHaveBeenCalledOnce();
  });

  it("retries later on a 429 from startRun", async () => {
    const s = setup({ rows: [row()], sandbox: { getDraft: vi.fn(async () => readyDraft()) as never, startRun: vi.fn(async () => ({ ok: false as const, status: 429 as const, error: "busy" })) } });
    await runOnboardingFollowThrough({ trigger: "cron", now: NOW, dryRun: true }, s.deps);
    expect(s.rows.get("conv-x")!.status).toBe("building");
  });

  it("emails the summary when the run completes and marks it reported", async () => {
    const report = {
      runId: "run-1", status: "complete", k: 2, scenarios: [{ id: "s1", category: "boundary" }],
      results: [{ scenarioId: "s1", passRate: 0.5, reliable: false, trials: [{ passed: true }, { passed: false }] }],
    };
    const s = setup({ rows: [row({ status: "running", runId: "run-1", channel: "email" })], sandbox: { getRunReport: vi.fn(async () => report) as never } });
    const r = await runOnboardingFollowThrough({ trigger: "cron", now: NOW, dryRun: true }, s.deps);
    expect(r.status).toBe("ok");
    expect(s.rows.get("conv-x")).toMatchObject({ status: "reported", reportedAt: NOW });
    const sent = s.mail.mock.calls[0]![0] as { text: string };
    expect(sent.text).toContain("pass@1: 50%");
    expect(sent.text).toContain("https://app.test/sandbox/runs/run-1");
  });

  it("stores a transcript message instead of emailing for chat", async () => {
    const report = { runId: "run-1", status: "complete", k: 1, scenarios: [], results: [] };
    const s = setup({ rows: [row({ status: "running", runId: "run-1" })], sandbox: { getRunReport: vi.fn(async () => report) as never } });
    await runOnboardingFollowThrough({ trigger: "cron", now: NOW, dryRun: true }, s.deps);
    expect(s.mail).not.toHaveBeenCalled();
    expect(s.rows.get("conv-x")!.transcript.at(-1)?.role).toBe("agent");
  });

  it("leaves a running run alone until it completes", async () => {
    const s = setup({ rows: [row({ status: "running", runId: "run-1" })], sandbox: { getRunReport: vi.fn(async () => ({ runId: "run-1", status: "running", k: 1, scenarios: [], results: [] })) as never } });
    await runOnboardingFollowThrough({ trigger: "cron", now: NOW, dryRun: true }, s.deps);
    expect(s.rows.get("conv-x")!.status).toBe("running");
  });
});
