import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ limit: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), stripe: vi.fn() }));
vi.mock("../db/client", () => ({ db: () => ({ select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: mocks.limit }) }) }) }) }),
  schema: { quotes: { stripeCheckoutSessionId: "session", jobId: "job", version: "version" } } }));
vi.mock("./stripe", () => ({ stripe: mocks.stripe, getStripeMode: vi.fn() }));
import { expireOpenCheckoutForCancellation } from "./checkout";
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("STRIPE_SECRET_KEY", "test");
  mocks.limit.mockResolvedValue([{ sessionId: "cs_retained" }]);
  mocks.stripe.mockReturnValue({ checkout: { sessions: { retrieve: mocks.retrieve, expire: mocks.expire } } });
});
it("proves absent sessions without requiring Stripe configuration", async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", ""); mocks.limit.mockResolvedValue([]);
  await expireOpenCheckoutForCancellation("job");
  expect(mocks.stripe).not.toHaveBeenCalled();
});
it("retries missing credentials when a session exists", async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  await expect(expireOpenCheckoutForCancellation("job")).rejects.toThrow("Stripe is required");
});
it.each(["complete", "expired"])("acknowledges proven %s sessions without expiry", async status => {
  mocks.retrieve.mockResolvedValue({ status }); await expireOpenCheckoutForCancellation("job");
  expect(mocks.expire).not.toHaveBeenCalled();
});
it("expires an open session and verifies returned status", async () => {
  mocks.retrieve.mockResolvedValue({ status: "open" }); mocks.expire.mockResolvedValue({ status: "expired" });
  await expireOpenCheckoutForCancellation("job"); expect(mocks.expire).toHaveBeenCalledWith("cs_retained");
  expect(mocks.retrieve).toHaveBeenCalledTimes(1);
});
it("rechecks inconclusive expiry and accepts a proven concurrent completion", async () => {
  mocks.retrieve.mockResolvedValueOnce({ status: "open" }).mockResolvedValueOnce({ status: "complete" });
  mocks.expire.mockResolvedValue({ status: null }); await expireOpenCheckoutForCancellation("job");
  expect(mocks.retrieve).toHaveBeenCalledTimes(2);
});
it("retries an expiry whose final state remains open", async () => {
  mocks.retrieve.mockResolvedValue({ status: "open" }); mocks.expire.mockResolvedValue({ status: "open" });
  await expect(expireOpenCheckoutForCancellation("job")).rejects.toThrow("not confirmed");
});
it.each(["transport", "authentication", "rate limit"])("preserves %s retrieval failure", async error => {
  mocks.retrieve.mockRejectedValue(new Error(error));
  await expect(expireOpenCheckoutForCancellation("job")).rejects.toThrow(error);
  expect(mocks.expire).not.toHaveBeenCalled();
});
it("preserves expiry transport failure", async () => {
  mocks.retrieve.mockResolvedValue({ status: "open" }); mocks.expire.mockRejectedValue(new Error("offline"));
  await expect(expireOpenCheckoutForCancellation("job")).rejects.toThrow("offline");
});
