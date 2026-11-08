import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(), list: vi.fn(), attempt: vi.fn(), checkoutAck: vi.fn(), eventAck: vi.fn(), expire: vi.fn(), send: vi.fn(),
}));
vi.mock("./job-cancellation", () => ({ getJobCancellation: mocks.get, listPendingCancellationJobs: mocks.list, markJobCancellationAttempt: mocks.attempt,
  markJobCancellationCheckoutDone: mocks.checkoutAck, markJobCancellationDelivered: mocks.eventAck }));
vi.mock("@ae/core/payments/checkout", () => ({ expireOpenCheckoutForCancellation: mocks.expire }));
vi.mock("@/workflows/events", () => ({ sendJobEvent: mocks.send }));
import { dispatchJobCancellation, drainJobCancellations } from "./job-cancellation-delivery";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({ jobId: "job", reason: "retained reason", checkoutDone: false, eventDelivered: false });
  mocks.list.mockResolvedValue(["job"]);
});
describe("durable cancellation delivery", () => {
  it("records retry rotation before external effects", async () => {
    mocks.attempt.mockRejectedValueOnce(new Error("db"));
    await expect(dispatchJobCancellation("job")).rejects.toThrow("db");
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("attempts notification even when Checkout expiry fails; only acknowledges success", async () => {
    mocks.expire.mockRejectedValue(new Error("offline"));
    expect(await dispatchJobCancellation("job")).toEqual({ jobId: "job", errors: ["checkout_expiry_pending"] });
    expect(mocks.checkoutAck).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith("job", { type: "cancel", reason: "retained reason" });
    expect(mocks.eventAck).toHaveBeenCalledWith("job");
  });
  it("keeps missing hooks pending and does not repeat completed Checkout work", async () => {
    mocks.get.mockResolvedValue({ reason: "original", checkoutDone: true, eventDelivered: false });
    mocks.send.mockRejectedValue(new Error("HookNotFoundError"));
    expect((await dispatchJobCancellation("job")).errors).toEqual(["workflow_notification_pending"]);
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.eventAck).not.toHaveBeenCalled();
  });
  it("retries sends after a lost acknowledgement (at-least-once)", async () => {
    mocks.eventAck.mockRejectedValueOnce(new Error("ack lost"));
    expect((await dispatchJobCancellation("job")).errors).toContain("workflow_notification_pending");
    await dispatchJobCancellation("job");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("skips acknowledged delivery and drains bounded rows despite a per-job error", async () => {
    mocks.list.mockResolvedValue(["broken", "done"]);
    mocks.get.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce({ checkoutDone: true, eventDelivered: true });
    expect(await drainJobCancellations(2)).toEqual({ attempted: 2, errors: ["broken:cancellation_delivery_pending"] });
    expect(mocks.list).toHaveBeenCalledWith(2);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
