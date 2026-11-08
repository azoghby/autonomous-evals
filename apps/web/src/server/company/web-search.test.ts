import { describe, expect, it } from "vitest";
import { assertNoCredentials } from "@ae/core/ai/gateway";
import { cleanSources, scrubCredentialLike } from "./web-search";

describe("web-search hygiene", () => {
  it("scrubs key-shaped strings from web text so the gateway guard does not reject research prompts", () => {
    const page = "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' -d key=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAA";
    const clean = scrubCredentialLike(page);
    expect(clean).toContain("[redacted-key]");
    expect(() => assertNoCredentials(clean)).not.toThrow();
  });

  it("keeps only http(s) URLs without userinfo, deduped, with scrubbed snippets", () => {
    const out = cleanSources([
      { url: "https://a.com/x", snippet: "token sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { url: "https://a.com/x" }, { url: "javascript:alert(1)" }, { url: "https://u:p@b.com" }, { url: 3 },
    ]);
    expect(out.map((s) => s.url)).toEqual(["https://a.com/x"]);
    expect(out[0].snippet).not.toMatch(/sk-A/);
  });
});
