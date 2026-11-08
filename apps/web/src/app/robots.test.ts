import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  it("disallows the real private routes, not a nonexistent /dashboard", () => {
    const rule = [robots().rules].flat()[0]!;
    const disallow = [rule.disallow].flat();
    for (const p of ["/jobs", "/evals", "/operator", "/settings", "/api/", "/r/", "/oauth/", "/expert/r/"]) expect(disallow).toContain(p);
    expect(disallow).not.toContain("/dashboard");
    expect(rule.allow).toBe("/");
  });
});
