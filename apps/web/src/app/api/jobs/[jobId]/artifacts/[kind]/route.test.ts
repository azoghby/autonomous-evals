import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  me: vi.fn(), viewer: vi.fn(), job: vi.fn(), text: vi.fn(),
}));
vi.mock("@/server/queries", () => ({ getCurrentCustomer: mocks.me, getJobForViewer: mocks.viewer }));
vi.mock("@/server/job-store", () => ({ getJob: mocks.job }));
vi.mock("@ae/core/storage/blob", () => ({ readJobArtifact: vi.fn(), readJobArtifactText: mocks.text }));

import { GET } from "./route";

const call = (qs = "") =>
  GET(new Request(`http://x/api/jobs/j1/artifacts/report-html${qs}`), { params: Promise.resolve({ jobId: "11111111-1111-1111-1111-111111111111", kind: "report-html" }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.me.mockResolvedValue({ id: "u1" });
  mocks.viewer.mockResolvedValue({ job: {} });
  mocks.job.mockResolvedValue({ reportBlobPath: "neon:jobs/x/report-1.md" });
  mocks.text.mockResolvedValue("# Title\n<script>alert(1)</script> **b**");
});

describe("report-html artifact", () => {
  it("401 when unauthenticated", async () => {
    mocks.me.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
  it("404 when viewer cannot see the job", async () => {
    mocks.viewer.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
  it("serves escaped html with strict headers, inline by default", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("<h1>Title</h1>");
  });
  it("uses attachment with ?download=1", async () => {
    const res = await call("?download=1");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="report-/);
  });
  it("404 when no report stored", async () => {
    mocks.job.mockResolvedValue({});
    expect((await call()).status).toBe(404);
  });
});
