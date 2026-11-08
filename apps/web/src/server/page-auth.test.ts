import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ me: null as null | { id: string }, fail: false }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { to }); } }));
vi.mock("./queries", () => ({ getCurrentCustomer: async () => { if (h.fail) throw new Error("db down"); return h.me; } }));

import { SessionUnavailableError, requireSignedInPage, signinRedirectPath } from "./page-auth";

describe("requireSignedInPage", () => {
  beforeEach(() => { h.me = null; h.fail = false; });

  it("redirects anonymous visitors to /signin with next", async () => {
    await expect(requireSignedInPage("/jobs/abc")).rejects.toMatchObject({ to: "/signin?next=%2Fjobs%2Fabc" });
  });

  it("returns the viewer when signed in", async () => {
    h.me = { id: "u1" };
    await expect(requireSignedInPage("/jobs")).resolves.toEqual({ id: "u1" });
  });

  it("shows an error state (throws) instead of redirecting to /signin when the session lookup fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.fail = true;
    await expect(requireSignedInPage("/jobs")).rejects.toBeInstanceOf(SessionUnavailableError);
    err.mockRestore();
  });

  it("never builds an off-site next", () => {
    expect(signinRedirectPath("//evil.com")).toBe("/signin?next=%2Fjobs");
  });
});
