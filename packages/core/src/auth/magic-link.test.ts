import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: () => ({}), schema: {} }));
vi.mock("./email", () => ({ sendEmail: vi.fn(), isEmailConfigured: () => false }));

import { devLinksEnabled } from "./magic-link";
import { maskEmail } from "./tokens";

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

describe("devLinksEnabled", () => {
  it("is allowed locally with AUTH_DEV_LINKS=1", () => {
    expect(devLinksEnabled(env({ AUTH_DEV_LINKS: "1" }), true)).toBe(true);
  });
  it("is allowed in local next start (NODE_ENV=production, no VERCEL_ENV) when explicitly enabled", () => {
    expect(devLinksEnabled(env({ AUTH_DEV_LINKS: "1", NODE_ENV: "production" }), true)).toBe(true);
  });
  it("is impossible on Vercel production even with AUTH_DEV_LINKS=1", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(devLinksEnabled(env({ AUTH_DEV_LINKS: "1", VERCEL_ENV: "production" }), true)).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    expect(devLinksEnabled(env({ AUTH_DEV_LINKS: "1", VERCEL_ENV: "production" }), true)).toBe(false);
    expect(err).toHaveBeenCalledTimes(1); // warns once
    err.mockRestore();
  });
  it("is impossible on Vercel preview, including the no-email fallback", () => {
    expect(devLinksEnabled(env({ VERCEL_ENV: "preview" }), false)).toBe(false);
  });
});

describe("maskEmail", () => {
  it("hides the local part", () => {
    expect(maskEmail("Alice@Example.com")).toBe("a***e@example.com");
    expect(maskEmail("ab@x.io")).toBe("a***@x.io");
  });
});
