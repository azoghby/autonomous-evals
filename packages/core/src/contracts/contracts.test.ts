import { describe, expect, it } from "vitest";
import {
  IntakeInput,
  JobEvent,
  MAX_TRACE_BYTES,
  PRICE_CENTS,
  jobHookToken,
} from "./index";

describe("PRICE_CENTS", () => {
  it("matches the pilot price table", () => {
    expect(PRICE_CENTS).toEqual({
      trace_audit: 500,
      text_eval: 500,
      workflow_eval: 500,
      version_comparison: 1000,
    });
  });
});

describe("IntakeInput", () => {
  const valid = { package: "trace_audit", trace: "{}", authorizedToTest: true } as const;

  it("accepts a valid trace audit", () => {
    expect(IntakeInput.safeParse(valid).success).toBe(true);
  });

  it("rejects a trace over 200 KB", () => {
    const r = IntakeInput.safeParse({ ...valid, trace: "x".repeat(MAX_TRACE_BYTES + 1) });
    expect(r.success).toBe(false);
  });

  it("rejects a non-HTTPS endpoint", () => {
    const r = IntakeInput.safeParse({
      package: "text_eval",
      endpoint: { url: "http://example.com/v1", model: "m" },
      authorizedToTest: true,
    });
    expect(r.success).toBe(false);
  });

  it("accepts an HTTPS endpoint", () => {
    const r = IntakeInput.safeParse({
      package: "text_eval",
      endpoint: { url: "https://example.com/v1", model: "m" },
      authorizedToTest: true,
    });
    expect(r.success).toBe(true);
  });

  it("requires authorizedToTest to be true", () => {
    expect(IntakeInput.safeParse({ ...valid, authorizedToTest: false }).success).toBe(false);
    const { authorizedToTest: _omit, ...missing } = valid;
    expect(IntakeInput.safeParse(missing).success).toBe(false);
  });
});

describe("JobEvent", () => {
  it("parses known events", () => {
    expect(JobEvent.parse({ type: "cancel", reason: "changed my mind" }).type).toBe("cancel");
    expect(JobEvent.parse({ type: "quote_accepted", quoteVersion: 1 })).toEqual({
      type: "quote_accepted",
      quoteVersion: 1,
    });
  });

  it("rejects unknown or malformed events", () => {
    expect(JobEvent.safeParse({ type: "nope" }).success).toBe(false);
    expect(JobEvent.safeParse({ type: "quote_accepted", quoteVersion: 0 }).success).toBe(false);
    expect(
      JobEvent.safeParse({ type: "payment_confirmed", paymentId: "not-uuid", quoteVersion: 1 }).success,
    ).toBe(false);
  });

  it("builds a stable hook token", () => {
    expect(jobHookToken("abc")).toBe("job:abc");
  });
});
