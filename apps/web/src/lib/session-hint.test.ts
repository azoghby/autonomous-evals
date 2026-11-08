import { describe, expect, it } from "vitest";
import { hasSessionHint } from "./session-hint";

describe("hasSessionHint", () => {
  it("detects the hint among other cookies and ignores look-alikes", () => {
    expect(hasSessionHint("a=1; ae_in=1; b=2")).toBe(true);
    expect(hasSessionHint("ae_in=1")).toBe(true);
    expect(hasSessionHint("")).toBe(false);
    expect(hasSessionHint("ae_in=; x=1")).toBe(false);
    expect(hasSessionHint("not_ae_in=1")).toBe(false);
  });
});
