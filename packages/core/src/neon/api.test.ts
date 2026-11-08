import { describe, expect, it, vi } from "vitest";
import { createNeonClient, NeonApiError, toRfc3339 } from "./api";

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}
const client = (f: ReturnType<typeof mockFetch>, timeoutMs?: number) =>
  createNeonClient({ apiKey: "secret-key", projectId: "proj-1", fetch: f as unknown as typeof fetch, timeoutMs });
const call = (f: ReturnType<typeof mockFetch>) => ({ url: String(f.mock.calls[0][0]), init: f.mock.calls[0][1]! });

describe("neon api client", () => {
  it("createSnapshot POSTs name and expires_at as query params", async () => {
    const f = mockFetch({ snapshot: { id: "snap-1", name: "n" } });
    const s = await client(f).createSnapshot("br-1", "job-x-delivered", { expiresAt: new Date("2026-11-20T10:00:00.123Z") });
    const { url, init } = call(f);
    expect(s.id).toBe("snap-1");
    expect(init.method).toBe("POST");
    expect(url).toBe("https://console.neon.tech/api/v2/projects/proj-1/branches/br-1/snapshot?name=job-x-delivered&expires_at=2026-11-20T10%3A00%3A00Z");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
  });

  it("restoreSnapshot never finalizes and never targets a branch", async () => {
    const f = mockFetch({ branch: { id: "br-new", name: "r" }, operations: [{ id: "op", status: "running" }] });
    const r = await client(f).restoreSnapshot("snap-1", "repro-1");
    const { url, init } = call(f);
    expect(url).toMatch(/\/snapshots\/snap-1\/restore$/);
    expect(JSON.parse(init.body as string)).toEqual({ name: "repro-1", finalize_restore: false });
    expect(r.branch.id).toBe("br-new");
  });

  it("setBranchExpiration PATCHes expires_at, null clears", async () => {
    const f = mockFetch({ branch: { id: "br-1", name: "b" } });
    await client(f).setBranchExpiration("br-1", new Date("2026-11-14T00:00:00Z"));
    expect(call(f).init.method).toBe("PATCH");
    expect(JSON.parse(call(f).init.body as string)).toEqual({ branch: { expires_at: "2026-11-14T00:00:00Z" } });
    const g = mockFetch({ branch: { id: "br-1", name: "b" } });
    await client(g).setBranchExpiration("br-1", null);
    expect(JSON.parse(call(g).init.body as string)).toEqual({ branch: { expires_at: null } });
  });

  it("listSnapshots and getBranch unwrap responses", async () => {
    expect(await client(mockFetch({ snapshots: [{ id: "a", name: "a" }] })).listSnapshots()).toHaveLength(1);
    expect((await client(mockFetch({ branch: { id: "br-9", name: "x" } })).getBranch("br-9")).id).toBe("br-9");
  });

  it("raises a clear error without leaking the key", async () => {
    const f = mockFetch({ message: "not allowed to snapshot non-root branch", code: "X" }, 400);
    const err = await client(f).createSnapshot("br-1", "n").catch((e) => e);
    expect(err).toBeInstanceOf(NeonApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("non-root");
    expect(err.message).not.toContain("secret-key");
  });

  it("times out", async () => {
    const f = vi.fn((_u: URL | string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const err = await client(f as never, 10).getBranch("br-1").catch((e) => e);
    expect(err.message).toContain("timed out");
  });

  it("toRfc3339 drops milliseconds", () => {
    expect(toRfc3339(new Date("2026-01-01T00:00:00.999Z"))).toBe("2026-01-01T00:00:00Z");
  });
});
