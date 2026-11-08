import { describe, expect, it, vi } from "vitest";
import { sessionLockDatabaseUrl, withSessionAdvisoryLock, type LockPool } from "./session-lock";

function fakePool(opts: { acquire?: boolean; unlock?: boolean | "throw" } = {}) {
  const released: Array<boolean | Error | undefined> = [];
  const pool: LockPool = {
    connect: async () => ({
      query: async (text: string) => {
        if (text.includes("try_advisory_lock")) return { rows: [{ ok: opts.acquire ?? true }] };
        if (opts.unlock === "throw") throw new Error("conn reset");
        return { rows: [{ ok: opts.unlock ?? true }] };
      },
      release: (d?: boolean | Error) => { released.push(d); },
    }),
    end: async () => {},
  };
  return { pool, released };
}

describe("session advisory lock", () => {
  it("prefers DATABASE_URL_UNPOOLED and falls back to DATABASE_URL only when unset", () => {
    expect(sessionLockDatabaseUrl({ DATABASE_URL: "postgres://x-pooler", DATABASE_URL_UNPOOLED: "postgres://x" })).toBe("postgres://x");
    expect(sessionLockDatabaseUrl({ DATABASE_URL: "postgres://x-pooler", DATABASE_URL_UNPOOLED: " " })).toBe("postgres://x-pooler");
  });

  it("runs fn, unlocks and returns the connection normally", async () => {
    const f = fakePool();
    expect(await withSessionAdvisoryLock(1n, async () => 42, async () => f.pool)).toEqual({ locked: false, value: 42 });
    expect(f.released).toEqual([undefined]);
  });

  it("skips when the lock is held", async () => {
    const f = fakePool({ acquire: false });
    const fn = vi.fn();
    expect(await withSessionAdvisoryLock(1n, fn, async () => f.pool)).toEqual({ locked: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([false, "throw"] as const)("destroys the connection when unlock returns %s", async (unlock) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakePool({ unlock });
    expect(await withSessionAdvisoryLock(1n, async () => "v", async () => f.pool)).toEqual({ locked: false, value: "v" });
    expect(f.released[0]).toBeInstanceOf(Error);
    err.mockRestore();
  });

  it("ends the pool and rethrows when connect fails", async () => {
    const end = vi.fn(async () => {});
    const pool: LockPool = { connect: async () => { throw new Error("ECONNREFUSED"); }, end };
    const fn = vi.fn();
    await expect(withSessionAdvisoryLock(1n, fn, async () => pool)).rejects.toThrow("ECONNREFUSED");
    expect(end).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });
});
