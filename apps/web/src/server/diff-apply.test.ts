import { describe, expect, it } from "vitest";
import { applyUnifiedDiff, looksLikeUnifiedDiff } from "./diff-apply";

const file = "line1\nline2\nline3\nline4\nline5\n";
const diff = "--- a/p.md\n+++ b/p.md\n@@ -2,3 +2,3 @@\n line2\n-line3\n+LINE3\n line4\n";

describe("applyUnifiedDiff", () => {
  it("applies a clean hunk", () => {
    expect(applyUnifiedDiff(file, diff)).toEqual({ ok: true, content: "line1\nline2\nLINE3\nline4\nline5\n" });
  });
  it("tolerates line-number drift", () => {
    const r = applyUnifiedDiff("new\nnew2\n" + file, diff);
    expect(r).toEqual({ ok: true, content: "new\nnew2\nline1\nline2\nLINE3\nline4\nline5\n" });
  });
  it("fails cleanly on mismatch", () => {
    const r = applyUnifiedDiff(file.replace("line3", "other"), diff);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/hunk 1/);
  });
  it("applies multiple hunks and additions", () => {
    const d = "@@ -1,1 +1,2 @@\n line1\n+inserted\n@@ -5,1 +6,1 @@\n-line5\n+five\n";
    expect(applyUnifiedDiff(file, d)).toEqual({ ok: true, content: "line1\ninserted\nline2\nline3\nline4\nfive\n" });
  });
  it("preserves CRLF endings", () => {
    const r = applyUnifiedDiff(file.replace(/\n/g, "\r\n"), diff);
    expect(r).toEqual({ ok: true, content: "line1\r\nline2\r\nLINE3\r\nline4\r\nline5\r\n" });
  });
  it("rejects malformed diffs and miscounted hunks", () => {
    expect(applyUnifiedDiff(file, "not a diff").ok).toBe(false);
    expect(applyUnifiedDiff(file, "@@ -1,3 +1,3 @@\n line1\n").ok).toBe(false);
  });
  it("handles no-newline-at-end markers", () => {
    const r = applyUnifiedDiff("a\nb", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
    expect(r).toEqual({ ok: true, content: "a\nc" });
  });
  it("detects diffs", () => {
    expect(looksLikeUnifiedDiff(diff)).toBe(true);
    expect(looksLikeUnifiedDiff("Always cite sources.")).toBe(false);
  });
});
