import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const sendEmail = vi.fn();
let configured = true;
vi.mock("@ae/core/auth/email", () => ({ isEmailConfigured: () => configured, sendEmail: (m: unknown) => sendEmail(m) }));
const rateLimit = vi.fn();
vi.mock("./rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));

import { alertOperators, buildAlertEmail, redactAlertText } from "./operator-alerts";

const alert = { kind: "job_failed", jobId: "job-12345678", title: "Job failed", detail: "State: failed. boom", severity: "critical" as const };

describe("alertOperators", () => {
  beforeEach(() => {
    sendEmail.mockReset().mockResolvedValue({ id: "1" });
    rateLimit.mockReset().mockResolvedValue({ ok: true, retryAfter: 0 });
    configured = true;
    process.env.OPERATOR_EMAILS = "a@x.com, B@x.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("emails every operator with text and html", async () => {
    expect(await alertOperators(alert)).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const m = sendEmail.mock.calls[0][0];
    expect(m.text).toContain("/operator");
    expect(m.html).toContain("<a href=");
  });

  it("dedupes per (kind, jobId) over 6h", async () => {
    await alertOperators(alert);
    expect(rateLimit).toHaveBeenCalledWith("operator-alert:job_failed:job-12345678", 1, 21600);
    rateLimit.mockResolvedValue({ ok: false, retryAfter: 100 });
    sendEmail.mockClear();
    expect(await alertOperators(alert)).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when sending or rate limiting fails", async () => {
    sendEmail.mockRejectedValue(new Error("smtp down"));
    await expect(alertOperators(alert)).resolves.toBe(false);
    rateLimit.mockRejectedValue(new Error("db"));
    await expect(alertOperators(alert)).resolves.toBe(false);
  });

  it("skips quietly with no operators or unconfigured email", async () => {
    process.env.OPERATOR_EMAILS = "";
    expect(await alertOperators(alert)).toBe(false);
    process.env.OPERATOR_EMAILS = "a@x.com"; configured = false;
    expect(await alertOperators(alert)).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("redaction", () => {
  it("strips credentials and truncates", () => {
    const e = buildAlertEmail({ ...alert, detail: `Authorization: abc123 Bearer tok.en-1234 sk_live_abcdefgh12345 postgres://u:pw@h/db ${"x ".repeat(400)}` });
    for (const bad of ["abc123", "tok.en-1234", "sk_live_abcdefgh12345", "u:pw@"]) {
      expect(e.text).not.toContain(bad);
      expect(e.html).not.toContain(bad);
    }
    expect(e.text.length).toBeLessThan(900);
  });
  it("escapes html", () => {
    expect(buildAlertEmail({ ...alert, title: "<script>x</script>" }).html).not.toContain("<script>");
    expect(redactAlertText("a   b")).toBe("a b");
  });
});
