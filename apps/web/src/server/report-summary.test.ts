import { describe, expect, it } from "vitest";
import { summaryFromMarkdown } from "./queries";

describe("summaryFromMarkdown", () => {
  it("reads the Summary section", () => {
    expect(summaryFromMarkdown("# Report\n\nIntro line.\n\n## Summary\n\nTwo issues found.\nOne is critical.\n\n## Findings\n- x")).toBe("Two issues found. One is critical.");
  });
  it("falls back to the first paragraph", () => {
    expect(summaryFromMarkdown("# Report\n\nThe agent mostly works.\n\n## Findings")).toBe("The agent mostly works.");
  });
  it("returns empty for empty input", () => {
    expect(summaryFromMarkdown("")).toBe("");
  });
});
