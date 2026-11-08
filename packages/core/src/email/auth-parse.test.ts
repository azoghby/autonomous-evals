import { describe, expect, it } from "vitest";
import { parseInboundEvent } from "./webhook";

const base = { event_type: "message.received", message: { message_id: "m", thread_id: "t", inbox_id: "i", from: ["a@b.c"], subject: "s", text: "x" } };
describe("parseInboundEvent auth verdicts", () => {
  it("extracts authentication_results", () => {
    const m = parseInboundEvent({ ...base, message: { ...base.message, authentication_results: { spf: "PASS", dkim: "fail" } } });
    expect(m?.auth).toEqual({ spf: "pass", dkim: "fail" });
  });
  it("leaves auth undefined when absent", () => {
    expect(parseInboundEvent(base)?.auth).toBeUndefined();
  });
});
