import { describe, expect, it, vi } from "vitest";

// service.ts wires real stores/services; only the pure parseEvalRef is exercised, so the heavy modules are stubbed.
vi.mock("@ae/core/db/client", () => ({ db: vi.fn(), schema: {} }));
vi.mock("@/server/queries", () => ({ getJobForViewer: vi.fn() }));
vi.mock("@/server/job-actions", () => ({ rerunFindingForJob: vi.fn() }));
vi.mock("@/server/share", () => ({ enableShare: vi.fn() }));
vi.mock("@/server/share-core", () => ({ shareUrls: vi.fn() }));
vi.mock("@/server/sandbox-service", () => ({ getSandboxService: vi.fn() }));

import { parseEvalRef } from "./service";

const RUN = "run_11111111-1111-4111-8111-111111111111";
const JOB = "33333333-3333-4333-8333-333333333333";

describe("parseEvalRef", () => {
  it("accepts a sandbox run id, the sample id, and a job uuid", () => {
    expect(parseEvalRef("sandbox_run", RUN)).toEqual({ kind: "sandbox_run", id: RUN });
    expect(parseEvalRef("sandbox_run", "sample")).toEqual({ kind: "sandbox_run", id: "sample" });
    expect(parseEvalRef("job", JOB)).toEqual({ kind: "job", id: JOB });
    expect(parseEvalRef("job", JOB.toUpperCase())).toEqual({ kind: "job", id: JOB.toUpperCase() });
  });
  it("rejects unknown kinds", () => {
    expect(parseEvalRef("suite", RUN)).toBeNull();
    expect(parseEvalRef("", JOB)).toBeNull();
    expect(parseEvalRef("__proto__", JOB)).toBeNull();
  });
  it("rejects ids of the wrong shape for the kind", () => {
    expect(parseEvalRef("job", RUN)).toBeNull();
    expect(parseEvalRef("sandbox_run", JOB)).toBeNull();
    expect(parseEvalRef("job", "sample")).toBeNull();
  });
  it.each([
    "", "run_", "run_123", `${RUN}x`, `x${RUN}`, `${RUN}\n`, "../etc/passwd", `${RUN}/../x`, "run_' OR 1=1 --", "SAMPLE", "sample ", " sample", "run_%00",
  ])("rejects malformed sandbox id %j", (id) => {
    expect(parseEvalRef("sandbox_run", id)).toBeNull();
  });
  it.each(["", "not-a-uuid", `${JOB}x`, `${JOB}\n`, "../../x", `${JOB}; DROP TABLE jobs`, JOB.slice(1)])("rejects malformed job id %j", (id) => {
    expect(parseEvalRef("job", id)).toBeNull();
  });
});
