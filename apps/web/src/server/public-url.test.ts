import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@ae/core/db/client", () => ({ db: () => { throw new Error("db must not be touched"); }, schema: {} }));

import { PRODUCTION_APP_URL, containsLocalUrl, publicAppUrl } from "./public-url";
import { appUrl, unsubscribeUrl } from "./owner-shared";

describe("publicAppUrl", () => {
  it("falls back to production when APP_URL is unset, http, or local", () => {
    expect(publicAppUrl({})).toBe(PRODUCTION_APP_URL);
    expect(publicAppUrl({ APP_URL: "http://localhost:3000" })).toBe(PRODUCTION_APP_URL);
    expect(publicAppUrl({ APP_URL: "https://localhost:3000" })).toBe(PRODUCTION_APP_URL);
    expect(publicAppUrl({ APP_URL: "http://127.0.0.1:3000" })).toBe(PRODUCTION_APP_URL);
    expect(publicAppUrl({ APP_URL: "http://standard-evals.vercel.app" })).toBe(PRODUCTION_APP_URL);
  });

  it("keeps a public https APP_URL, without trailing slash", () => {
    expect(publicAppUrl({ APP_URL: "https://standard-evals.vercel.app/" })).toBe("https://standard-evals.vercel.app");
    expect(publicAppUrl({ APP_URL: "https://evals.example.com" })).toBe("https://evals.example.com");
  });

  it("detects local URLs in text", () => {
    expect(containsLocalUrl("unsubscribe: http://localhost:3000/api/x")).toBe(true);
    expect(containsLocalUrl("see http://127.0.0.1:3000")).toBe(true);
    expect(containsLocalUrl(`see ${PRODUCTION_APP_URL}/demo`)).toBe(false);
  });
});

describe("outreach / unsubscribe links", () => {
  const prev = { APP_URL: process.env.APP_URL, SESSION_SECRET: process.env.SESSION_SECRET };
  afterEach(() => { process.env.APP_URL = prev.APP_URL; process.env.SESSION_SECRET = prev.SESSION_SECRET; if (prev.APP_URL === undefined) delete process.env.APP_URL; });

  it("never builds a localhost unsubscribe link, even when APP_URL is local or missing", () => {
    process.env.SESSION_SECRET = "test-secret";
    for (const v of [undefined, "http://localhost:3000"]) {
      if (v === undefined) delete process.env.APP_URL; else process.env.APP_URL = v;
      expect(appUrl()).toBe(PRODUCTION_APP_URL);
      const u = unsubscribeUrl("a@b.co");
      expect(u.startsWith(`${PRODUCTION_APP_URL}/api/leaderboard/unsubscribe?t=`)).toBe(true);
      expect(containsLocalUrl(u)).toBe(false);
    }
  });
});
