import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ me: null as null | { id: string } }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { to }); } }));
vi.mock("./queries", () => ({ getCurrentCustomer: async () => h.me }));

import { requireSignedInPage, signinRedirectPath } from "./page-auth";

describe("requireSignedInPage", () => {
  beforeEach(() => { h.me = null; });

  it("redirects anonymous visitors to /signin with next", async () => {
    await expect(requireSignedInPage("/jobs/abc")).rejects.toMatchObject({ to: "/signin?next=%2Fjobs%2Fabc" });
  });

  it("returns the viewer when signed in", async () => {
    h.me = { id: "u1" };
    await expect(requireSignedInPage("/jobs")).resolves.toEqual({ id: "u1" });
  });

  it("never builds an off-site next", () => {
    expect(signinRedirectPath("//evil.com")).toBe("/signin?next=%2Fjobs");
  });
});
