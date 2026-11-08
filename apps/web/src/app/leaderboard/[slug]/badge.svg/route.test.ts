import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/leaderboard-db", () => ({ getAgentDetail: async (slug: string) => (slug === "known-agent" ? { entry: {} } : null) }));
vi.mock("@/server/leaderboard", () => ({ badgeText: () => "pass 90%", badgeTone: () => "ok" }));
vi.mock("@/server/share-core", () => ({ invalidBadgeSvg: () => "<svg/>", renderBadgeSvg: () => "<svg>ok</svg>" }));

import { GET } from "./route";

const get = (slug: string) => GET(new Request(`http://x/leaderboard/${slug}/badge.svg`), { params: Promise.resolve({ slug }) });

describe("leaderboard badge", () => {
  it("does not publicly cache the 404 for an unknown or invalid slug", async () => {
    for (const slug of ["nope-agent", "BAD SLUG"]) {
      const res = await get(slug);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("caches a real badge publicly", async () => {
    const res = await get("known-agent");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
  });
});
