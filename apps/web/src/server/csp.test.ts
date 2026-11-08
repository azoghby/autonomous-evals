import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "./csp";

const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split("; ").map((d) => { const [k, ...v] = d.split(" "); return [k, v]; }));

describe("Content-Security-Policy (report-only)", () => {
  it("locks down framing, plugins and base", () => {
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["default-src"]).toEqual(["'self'"]);
  });
  it("allows the origins the app uses: Stripe redirects, Vercel toolbar, self-hosted fonts/analytics", () => {
    expect(directives["form-action"]).toContain("https://checkout.stripe.com");
    expect(directives["script-src"]).toContain("https://vercel.live");
    expect(directives["font-src"]).toContain("'self'");
    expect(directives["script-src"]).not.toContain("*");
  });
});
