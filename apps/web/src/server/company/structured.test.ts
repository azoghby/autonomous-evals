import { describe, expect, it } from "vitest";
import { assertNoCredentials } from "@ae/core/ai/gateway";
import { maskUrls } from "./structured";

describe("maskUrls", () => {
  it("lets public URL slugs through the credential guard while real keys in prose still trip it", () => {
    const slug = "Source: https://example.com/blog/best-help-desk-ai-customer-service-agents-2026";
    expect(() => assertNoCredentials(slug)).toThrow();
    expect(() => assertNoCredentials(maskUrls(slug))).not.toThrow();
    expect(() => assertNoCredentials(maskUrls("my key is sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAA"))).toThrow();
  });
});
