import { describe, expect, it } from "vitest";
import { createNeonBranchManager, NeonBranchError, neonBranchManagerFromEnv } from "./neon-branches";

const API_KEY = "napi_SECRET_KEY_123";

interface Call { method: string; url: string; body: unknown }
type Handler = (call: Call, index: number) => Response | Promise<Response>;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(handler: Handler, projectId = "proj-a", extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const mgr = createNeonBranchManager({ apiKey: API_KEY, projectId, fetch: fetchFn, sleep, ...extra });
  return { mgr, calls, sleeps };
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const created = (id = "br-new-1", opId = "op-1", status = "running") =>
  json(201, {
    branch: { id, name: "sbx", parent_id: "br-parent", expires_at: "2026-11-08T15:00:00Z" },
    endpoints: [{ id: "ep-1" }],
    operations: [{ id: opId, status }],
  });

describe("createBranch", () => {
  it("creates, polls operations until finished, and returns info", async () => {
    const statuses = ["running", "finished"];
    const { mgr, calls, sleeps } = setup((c) => {
      if (c.method === "POST") return created();
      return json(200, { operation: { id: "op-1", status: statuses.shift() } });
    });
    const info = await mgr.createBranch({
      name: "sbx",
      parentId: "br-parent",
      expiresAt: new Date("2026-11-08T15:00:00.789Z"),
    });
    expect(info).toEqual({ branchId: "br-new-1", name: "sbx", parentId: "br-parent", expiresAt: "2026-11-08T15:00:00Z" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://console.neon.tech/api/v2/projects/proj-a/branches");
    expect(calls[0]!.body).toEqual({
      branch: { name: "sbx", parent_id: "br-parent", expires_at: "2026-11-08T15:00:00Z" },
      endpoints: [{ type: "read_write" }],
    });
    expect(calls.filter((c) => c.url.endsWith("/operations/op-1"))).toHaveLength(2);
    expect(sleeps).toEqual([500, 500]);
  });

  it("throws when an operation fails", async () => {
    const { mgr } = setup((c) =>
      c.method === "POST" ? created() : json(200, { operation: { id: "op-1", status: "failed" } }),
    );
    await expect(mgr.createBranch({ name: "x", parentId: "br-parent" })).rejects.toThrow(/operation op-1 failed/);
  });

  it("times out waiting on a stuck operation", async () => {
    const { mgr } = setup(
      (c) => (c.method === "POST" ? created() : json(200, { operation: { id: "op-1", status: "running" } })),
      "proj-timeout",
      { operationTimeoutMs: 2000, pollIntervalMs: 500 },
    );
    await expect(mgr.createBranch({ name: "x", parentId: "br-parent" })).rejects.toThrow(/timed out/);
  });

  it("rejects invalid ids before any request", async () => {
    const { mgr, calls } = setup(() => json(200, {}));
    await expect(mgr.createBranch({ name: "x", parentId: "../evil" })).rejects.toBeInstanceOf(NeonBranchError);
    await expect(mgr.deleteBranch("br-OK/../x")).rejects.toBeInstanceOf(NeonBranchError);
    expect(calls).toHaveLength(0);
    expect(() => createNeonBranchManager({ apiKey: "k", projectId: "Bad/Id" })).toThrow(NeonBranchError);
  });
});

describe("retry", () => {
  it("retries 423 twice with growing backoff, then succeeds", async () => {
    let posts = 0;
    const { mgr, sleeps } = setup((c) => {
      if (c.method === "POST") return ++posts <= 2 ? json(423, { message: "locked" }) : created("br-new-1", "op-1", "finished");
      return json(200, {});
    });
    const info = await mgr.createBranch({ name: "x", parentId: "br-parent" });
    expect(info.branchId).toBe("br-new-1");
    expect(posts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]).toBeLessThan(700);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!);
  });

  it("gives up after maxRetries and throws NeonBranchError with status", async () => {
    const { mgr, calls } = setup(() => json(503, { message: "down" }), "proj-b", { maxRetries: 2 });
    const err = await mgr.listBranches().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeonBranchError);
    expect((err as NeonBranchError).status).toBe(503);
    expect((err as NeonBranchError).operation).toBe("listBranches");
    expect(calls).toHaveLength(3);
  });

  it("retries network errors on GET but not on POST", async () => {
    let gets = 0;
    const g = setup(() => {
      if (++gets < 3) throw new TypeError("fetch failed");
      return json(200, { branches: [] });
    });
    expect(await g.mgr.listBranches()).toEqual([]);
    expect(gets).toBe(3);

    let posts = 0;
    const p = setup(() => { posts++; throw new TypeError("fetch failed"); }, "proj-c");
    await expect(p.mgr.createBranch({ name: "x", parentId: "br-parent" })).rejects.toThrow(/network/);
    expect(posts).toBe(1);
  });

  it("does not retry other 4xx and never leaks the api key", async () => {
    const { mgr, calls } = setup(() =>
      json(401, { message: `bad token ${API_KEY} ${"x".repeat(500)}` }),
    );
    const err = (await mgr.listBranches().catch((e: unknown) => e)) as NeonBranchError;
    expect(calls).toHaveLength(1);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).toContain("[redacted]");
    expect(err.message.length).toBeLessThan(400);
  });
});

describe("serialization", () => {
  it("does not issue the second POST until the first's operations finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const { mgr, calls } = setup(async (c) => {
      if (c.method === "POST") {
        n++;
        return created(`br-new-${n}`, `op-${n}`);
      }
      if (c.url.endsWith("/operations/op-1")) await gate;
      return json(200, { operation: { id: "x", status: "finished" } });
    }, "proj-serial");
    const a = mgr.createBranch({ name: "a", parentId: "br-parent" });
    const b = mgr.createBranch({ name: "b", parentId: "br-parent" });
    await flush();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    release();
    const [ia, ib] = await Promise.all([a, b]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect([ia.branchId, ib.branchId]).toEqual(["br-new-1", "br-new-2"]);
  });

  it("keeps the queue alive after a failed mutation", async () => {
    let n = 0;
    const { mgr } = setup((c) => {
      if (c.method === "POST" && ++n === 1) return json(400, { message: "nope" });
      return created("br-new-2", "op-2", "finished");
    }, "proj-fail");
    const a = mgr.createBranch({ name: "a", parentId: "br-parent" });
    const b = mgr.createBranch({ name: "b", parentId: "br-parent" });
    await expect(a).rejects.toThrow(/400/);
    expect((await b).branchId).toBe("br-new-2");
  });
});

describe("deleteBranch / resetFromParent", () => {
  it("treats 404 as success", async () => {
    const { mgr } = setup(() => json(404, { message: "not found" }));
    await expect(mgr.deleteBranch("br-gone-1")).resolves.toBeUndefined();
  });

  it("waits for delete operations", async () => {
    const { mgr, calls } = setup((c) =>
      c.method === "DELETE"
        ? json(200, { branch: { id: "br-d" }, operations: [{ id: "op-9", status: "running" }] })
        : json(200, { operation: { id: "op-9", status: "finished" } }),
    );
    await mgr.deleteBranch("br-d");
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "GET"]);
  });

  it("restores from the parent", async () => {
    const { mgr, calls } = setup(() => json(200, { branch: { id: "br-c" }, operations: [{ id: "o", status: "finished" }] }));
    await mgr.resetFromParent("br-c", "br-parent");
    expect(calls[0]!.url).toBe("https://console.neon.tech/api/v2/projects/proj-a/branches/br-c/restore");
    expect(calls[0]!.body).toEqual({ source_branch_id: "br-parent" });
  });
});

describe("connectionUri and roles", () => {
  const direct = "postgresql://neondb_owner:pw@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require";

  it("builds the query, prefers neondb_owner, and caches the role", async () => {
    const { mgr, calls } = setup((c) =>
      c.url.includes("/roles")
        ? json(200, { roles: [{ name: "cloud_admin" }, { name: "app_user" }, { name: "neondb_owner" }] })
        : json(200, { uri: direct }),
    );
    expect(await mgr.connectionUri("br-abc", "neondb")).toBe(direct);
    await mgr.connectionUri("br-abc", "other");
    const uriCalls = calls.filter((c) => c.url.includes("/connection_uri"));
    const q = new URL(uriCalls[0]!.url).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      branch_id: "br-abc",
      database_name: "neondb",
      role_name: "neondb_owner",
      pooled: "false",
    });
    expect(calls.filter((c) => c.url.includes("/roles"))).toHaveLength(1);
  });

  it("falls back to the first non-system role", async () => {
    const { mgr, calls } = setup((c) =>
      c.url.includes("/roles")
        ? json(200, { roles: [{ name: "authenticator" }, { name: "neon_superuser" }, { name: "app_user" }] })
        : json(200, { uri: direct }),
    );
    await mgr.connectionUri("br-abc", "db");
    expect(new URL(calls[1]!.url).searchParams.get("role_name")).toBe("app_user");
  });

  it("uses an explicit role without listing roles", async () => {
    const { mgr, calls } = setup(() => json(200, { uri: direct }));
    await mgr.connectionUri("br-abc", "db", "me");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("role_name")).toBe("me");
  });

  it("rejects pooled hosts", async () => {
    const { mgr } = setup(() => json(200, { uri: "postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db" }));
    await expect(mgr.connectionUri("br-abc", "db", "me")).rejects.toThrow(/non-pooled/);
  });
});

describe("listing", () => {
  it("lists branches and finds the default", async () => {
    const { mgr } = setup(() =>
      json(200, {
        branches: [
          { id: "br-a", name: "feat", parent_id: "br-main" },
          { id: "br-main", name: "main", default: true },
        ],
      }),
    );
    expect(await mgr.listBranches()).toEqual([
      { branchId: "br-a", name: "feat", parentId: "br-main" },
      { branchId: "br-main", name: "main" },
    ]);
    expect(await mgr.defaultBranchId()).toBe("br-main");
  });
});

describe("neonBranchManagerFromEnv", () => {
  it("requires both env vars", () => {
    expect(() => neonBranchManagerFromEnv({})).toThrow(/NEON_API_KEY/);
    expect(() => neonBranchManagerFromEnv({ NEON_API_KEY: "k" })).toThrow(/NEON_PROJECT_ID/);
    expect(neonBranchManagerFromEnv({ NEON_API_KEY: "k", NEON_PROJECT_ID: "proj-x" })).toBeDefined();
  });
});
