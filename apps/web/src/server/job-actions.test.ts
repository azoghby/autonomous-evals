import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  existing: 0,
  claim: vi.fn(async (_id: string): Promise<string | null> => "rerun-slot:f1:1"),
  release: vi.fn(async (_k: string) => {}),
  rerunFinding: vi.fn(),
}));

vi.mock("@ae/core/db/client", () => ({
  schema: { findings: { jobId: "job_id", rerunOfFindingId: "rerun_of", createdAt: "created_at" } },
  db: () => ({ select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([{ n: h.existing }]), { orderBy: () => Promise.resolve([{ id: "saved" }]) }) }) }) }),
}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: () => ({}), count: () => ({}) }));
vi.mock("@ae/core/storage/blob", () => ({ readJobArtifactText: async () => null }));
vi.mock("@ae/core/contracts/index", () => ({ Finding: { safeParse: (d: unknown) => ({ success: true, data: d }), parse: (d: unknown) => d }, Suite: { safeParse: () => ({ success: false }) } }));
vi.mock("./job-store", () => ({
  addMessage: vi.fn(), getJob: async () => ({ suiteBlobPath: null }), saveFindings: vi.fn(),
  makeServiceContext: async () => ({ recordProgress: async () => {} }),
}));
vi.mock("./services", () => ({ getEvalServices: async () => ({ rerunFinding: h.rerunFinding }) }));
vi.mock("@/workflows/events", () => ({ sendJobEvent: vi.fn() }));
vi.mock("./rerun-slots", () => ({ MAX_RERUNS_PER_FINDING: 3, claimRerunSlot: h.claim, releaseRerunSlot: h.release }));

import { rerunFindingForJob } from "./job-actions";

const FID = "11111111-1111-4111-8111-111111111111";
const finding = { id: "x", title: "t", severity: "high", category: "c", evidence: [], scenarioId: null };
const data = { job: { id: "job1", state: "delivered" }, findings: [{ id: FID, rerunOfFindingId: null, data: finding }] } as never;

describe("rerunFindingForJob", () => {
  beforeEach(() => { vi.clearAllMocks(); h.existing = 0; h.claim.mockResolvedValue("rerun-slot:f1:1"); });

  it("refuses without running when no slot can be claimed (a concurrent request took the last one)", async () => {
    h.claim.mockResolvedValue(null);
    expect(await rerunFindingForJob(data, FID)).toMatchObject({ ok: false, status: 409 });
    expect(h.rerunFinding).not.toHaveBeenCalled();
  });

  it("refuses before claiming once the stored count hits the limit", async () => {
    h.existing = 3;
    expect(await rerunFindingForJob(data, FID)).toMatchObject({ ok: false, status: 409 });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("gives the slot back when the re-run fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.rerunFinding.mockRejectedValue(new Error("boom"));
    expect(await rerunFindingForJob(data, FID)).toMatchObject({ ok: false, status: 502 });
    expect(h.release).toHaveBeenCalledWith("rerun-slot:f1:1");
    err.mockRestore();
  });
});
