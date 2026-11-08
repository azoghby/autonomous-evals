import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/workflow-stage-runtime", () => ({ assertWorkflowStageCurrent: vi.fn() }));
vi.mock("workflow", () => ({ FatalError: class extends Error {} }));
vi.mock("@ae/core/db/client", () => ({ db: () => ({}), schema: {} }));
vi.mock("@ae/core/storage/blob", () => ({ putJobArtifact: vi.fn() }));
vi.mock("@/server/job-store", () => ({
  findingRowIdByKey: vi.fn(), recordProgress: vi.fn(), saveFindings: vi.fn(), saveRemediation: vi.fn(), setJobState: vi.fn(),
}));
vi.mock("./common", () => ({
  loadIntake: vi.fn(), withBudget: vi.fn(), requireJob: vi.fn(async () => ({ state: "planning", neonBranchId: null })),
}));
vi.mock("@/server/services", () => ({
  getEvalServices: async () => ({
    createJobBranch: async () => ({ branchId: "b1", connectionString: "postgres://user:SECRET@host/db" }),
    deleteJobBranch: vi.fn(),
  }),
}));

import { createBranchStep } from "./evaluate";
import { setJobState } from "@/server/job-store";

describe("createBranchStep", () => {
  it("returns only the branch id and never the connection string", async () => {
    const out = await createBranchStep("job-1");
    expect(out).toEqual({ branchId: "b1" });
    expect(out).not.toHaveProperty("connectionString");
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(setJobState).toHaveBeenCalledWith("job-1", "planning", { neonBranchId: "b1" });
  });
});
