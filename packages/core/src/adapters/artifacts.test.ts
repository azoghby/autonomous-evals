import { describe, expect, it, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  putJobArtifact: vi.fn(async () => "neon:jobs/j1/agent-x-abc.json"),
  readJobArtifact: vi.fn(),
}));
vi.mock("../storage/blob", async (orig) => ({ ...(await orig<typeof import("../storage/blob")>()), ...store }));

import { createArtifactStore, assertArtifactName } from "./artifacts";

beforeEach(() => vi.clearAllMocks());

describe("artifact names", () => {
  it.each(["report.json", "trace-1_a.txt", "a"])("accepts %s", (n) => expect(() => assertArtifactName(n)).not.toThrow());
  it.each(["", "../x", "a/b", "a..b", ".hidden", "UPPER", "sp ace", "a\\b", "x".repeat(101)])("rejects %j", (n) => expect(() => assertArtifactName(n)).toThrow());
});

describe("artifact store", () => {
  it("put validates the name before touching storage and returns the pathname", async () => {
    const s = createArtifactStore("j1");
    await expect(s.put("../etc", "x", "text/plain")).rejects.toThrow(/Invalid artifact name/);
    expect(store.putJobArtifact).not.toHaveBeenCalled();
    expect(await s.put("x.json", "{}", "application/json")).toEqual({ pathname: "neon:jobs/j1/agent-x-abc.json" });
    expect(store.putJobArtifact).toHaveBeenCalledWith("j1", "agent-x.json", "{}", "application/json");
  });

  it("get reads own-job paths and returns bytes", async () => {
    store.readJobArtifact.mockResolvedValueOnce({ stream: new Response("hi").body, contentType: "text/plain", size: 2 });
    const r = await createArtifactStore("j1").get("neon:jobs/j1/agent-x-abc.txt");
    expect(new TextDecoder().decode(r!.body)).toBe("hi");
    expect(r!.contentType).toBe("text/plain");
  });

  it("get refuses other jobs' and traversal paths", async () => {
    const s = createArtifactStore("j1");
    await expect(s.get("neon:jobs/j2/x.txt")).rejects.toThrow(/outside this job/);
    await expect(s.get("jobs/j1/../j2/x.txt")).rejects.toThrow(/outside this job/);
    expect(store.readJobArtifact).not.toHaveBeenCalled();
  });

  it("get returns null when missing", async () => {
    store.readJobArtifact.mockResolvedValueOnce(null);
    expect(await createArtifactStore("j1").get("neon:jobs/j1/nope")).toBeNull();
  });
});
