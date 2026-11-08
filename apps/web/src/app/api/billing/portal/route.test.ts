import { beforeEach, describe, expect, it, vi } from "vitest";

const me = vi.hoisted(() => ({ value: null as null | { id: string; email: string; isOperator: boolean } }));
const row = vi.hoisted(() => ({ value: undefined as undefined | Record<string, unknown> }));
const create = vi.hoisted(() => vi.fn());

vi.mock("@/server/queries", () => ({ getCurrentCustomer: async () => me.value }));
vi.mock("@/server/session", () => ({ getCurrentCustomer: async () => me.value }));
vi.mock("@ae/core/db/client", () => ({
  db: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => (row.value ? [row.value] : []) }) }) }) }),
  schema: { customers: new Proxy({}, { get: (_t, c) => String(c) }) },
}));
vi.mock("@ae/core/payments/stripe", () => ({ stripe: () => ({ billingPortal: { sessions: { create } } }) }));

import { POST } from "./route";

const post = () => POST(new Request("https://app.test/api/billing/portal", { method: "POST" }));

beforeEach(() => {
  vi.clearAllMocks();
  me.value = { id: "c1", email: "a@b.co", isOperator: false };
  row.value = { stripeCustomerId: "cus_1" };
  create.mockResolvedValue({ url: "https://billing.stripe.test/p/session" });
  delete process.env.APP_URL;
});

describe("POST /api/billing/portal", () => {
  it("401s when signed out", async () => {
    me.value = null;
    expect((await post()).status).toBe(401);
  });
  it("409s with a pricing link when there is no Stripe customer", async () => {
    row.value = { stripeCustomerId: null };
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "No billing account yet — choose a plan first", href: "/pricing" });
    expect(create).not.toHaveBeenCalled();
  });
  it("returns the portal URL with a billing return URL", async () => {
    const res = await post();
    expect(await res.json()).toEqual({ url: "https://billing.stripe.test/p/session" });
    expect(create).toHaveBeenCalledWith({ customer: "cus_1", return_url: "https://app.test/settings/billing" });
  });
  it("prefers APP_URL for the return URL", async () => {
    process.env.APP_URL = "https://standard.example/";
    await post();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ return_url: "https://standard.example/settings/billing" }));
  });
  it("502s with a safe message when Stripe errors", async () => {
    create.mockRejectedValue(new Error("No configuration provided and your test mode default configuration has not been created"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post();
    expect(res.status).toBe(502);
    const body = JSON.stringify(await res.json());
    expect(body).toMatch(/billing portal is unavailable/);
    expect(body).not.toMatch(/configuration/);
  });
});
