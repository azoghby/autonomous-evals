import { describe, expect, it, vi, beforeEach } from "vitest";

const neon = vi.hoisted(() => ({
  neonPut: vi.fn(async () => {}), neonGet: vi.fn(async () => ({ stream: new Response("x").body!, contentType: "text/plain", size: 1 })),
  neonDelete: vi.fn(async () => {}),
}));
const blob = vi.hoisted(() => ({
  put: vi.fn(async (p: string) => ({ pathname: p + "-rand" })),
  get: vi.fn(async () => ({ statusCode: 200, stream: new Response("b").body!, blob: { contentType: "text/plain", size: 1 } })),
}));
vi.mock("./neon-storage", async (orig) => ({ ...(await orig<typeof import("./neon-storage")>()), ...neon }));
vi.mock("@vercel/blob", () => blob);

import { selectBackend, parsePathname, putJobArtifact, readJobArtifactText } from "./blob";

const NEON_ENV = { NEON_STORAGE_ENDPOINT: "https://e", NEON_STORAGE_BUCKET: "artifacts", NEON_STORAGE_ACCESS_KEY_ID: "a", NEON_STORAGE_SECRET_ACCESS_KEY: "s" };

beforeEach(() => { vi.clearAllMocks(); for (const k of [...Object.keys(NEON_ENV), "ARTIFACT_STORE"]) vi.stubEnv(k, ""); });

describe("selectBackend", () => {
  it("defaults to neon when NEON_STORAGE_* complete, else blob", () => {
    expect(selectBackend(NEON_ENV)).toBe("neon");
    expect(selectBackend({})).toBe("blob");
    expect(selectBackend({ ...NEON_ENV, NEON_STORAGE_BUCKET: "" })).toBe("blob");
  });
  it("ARTIFACT_STORE overrides", () => {
    expect(selectBackend({ ...NEON_ENV, ARTIFACT_STORE: "blob" })).toBe("blob");
    expect(selectBackend({ ARTIFACT_STORE: "NEON" })).toBe("neon");
  });
});

describe("parsePathname", () => {
  it("routes by prefix, legacy unprefixed is blob", () => {
    expect(parsePathname("neon:jobs/a/report-1.md")).toEqual({ backend: "neon", key: "jobs/a/report-1.md" });
    expect(parsePathname("blob:jobs/a/r.md")).toEqual({ backend: "blob", key: "jobs/a/r.md" });
    expect(parsePathname("jobs/a/r.md")).toEqual({ backend: "blob", key: "jobs/a/r.md" });
  });
});

describe("put/read routing", () => {
  it("writes to neon with prefix when configured", async () => {
    for (const [k, v] of Object.entries(NEON_ENV)) vi.stubEnv(k, v);
    const p = await putJobArtifact("job1", "report", "hi", "text/markdown");
    expect(p).toMatch(/^neon:jobs\/job1\/report-[0-9a-f]{12}\.md$/);
    expect(neon.neonPut).toHaveBeenCalledOnce();
    expect(blob.put).not.toHaveBeenCalled();
  });
  it("falls back to blob with prefix", async () => {
    const p = await putJobArtifact("job1", "suite", "{}", "application/json");
    expect(p).toBe("blob:jobs/job1/suite.json-rand");
    expect(neon.neonPut).not.toHaveBeenCalled();
  });
  it("reads each backend by prefix and passes unprefixed to blob", async () => {
    await readJobArtifactText("neon:jobs/j/report-aa.md");
    expect(neon.neonGet).toHaveBeenCalledWith("jobs/j/report-aa.md");
    await readJobArtifactText("blob:jobs/j/r.md");
    await readJobArtifactText("jobs/j/old.md");
    expect(blob.get).toHaveBeenNthCalledWith(1, "jobs/j/r.md", expect.anything());
    expect(blob.get).toHaveBeenNthCalledWith(2, "jobs/j/old.md", expect.anything());
  });
});
