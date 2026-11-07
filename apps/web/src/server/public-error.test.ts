import { describe, expect, it } from "vitest";
import { GENERIC_JOB_ERROR, publicJobError } from "./public-error";

describe("publicJobError", () => {
  it("returns null when there is no error", () => {
    expect(publicJobError(null, false)).toBeNull();
    expect(publicJobError("", true)).toBeNull();
  });
  it("hides raw errors from customers", () => {
    expect(publicJobError("ECONNREFUSED 10.0.0.1 secret=abc", false)).toBe(GENERIC_JOB_ERROR);
  });
  it("shows raw errors to operators", () => {
    expect(publicJobError("boom", true)).toBe("boom");
  });
});
