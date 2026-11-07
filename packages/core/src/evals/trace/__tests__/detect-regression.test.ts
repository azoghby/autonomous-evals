import { describe, expect, it } from "vitest";
import { detect, extractInstructionRules } from "../detect";
import { normalizeTrace } from "../normalize";

const call = (id: string, name: string, args = "{}") => ({
  role: "assistant", tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
});
const result = (id: string, ok: boolean) => ({
  role: "tool", tool_call_id: id, content: JSON.stringify(ok ? { ok: true } : { ok: false, error: "dependency unavailable" }),
});
const analyze = (events: unknown[], instructions: string | null = null) => detect(normalizeTrace(JSON.stringify(events)), instructions);

describe("D7: relevance follows the action rather than argument topic mentions", () => {
  it("keeps email success supported after unrelated analytics failure mentioning email", () => {
    const out = analyze([
      call("mail", "send_email"), result("mail", true),
      call("log", "log_analytics", '{"event":"email sent"}'), result("log", false),
      { role: "assistant", content: "I sent the email." },
    ]);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({ status: "supported", evidenceEventIds: ["e1", "e2"] });
    expect(out.candidates.filter((c) => c.category === "unsupported_claim")).toEqual([]);
    // The analytics error is still a separate unacknowledged error, not silently erased.
    expect(out.candidates.map((c) => c.title)).toEqual(["Tool error from log_analytics not acknowledged"]);
  });

  it("does not let unrelated analytics success mask an email failure", () => {
    const out = analyze([
      call("mail", "send_email"), result("mail", false),
      call("log", "log_analytics", '{"event":"email sent"}'), result("log", true),
      { role: "assistant", content: "I sent the email." },
    ]);
    expect(out.claims[0]).toMatchObject({ status: "contradicted", evidenceEventIds: ["e1", "e2"] });
    expect(out.candidates[0]).toMatchObject({ basis: "objective", severity: "high", title: "Success claimed after send_email reported failure" });
  });

  it("uses the latest retry of the relevant tool", () => {
    const out = analyze([
      call("first", "send_email"), result("first", false),
      call("retry", "send_email"), result("retry", true),
      { role: "assistant", content: "The email was sent." },
    ]);
    expect(out.claims[0]).toMatchObject({ status: "supported", evidenceEventIds: ["e3", "e4"] });
    expect(out.candidates).toEqual([]);
  });

  it("retains command-based evidence for generic shell executors", () => {
    const out = analyze([
      call("test", "run_shell", '{"cmd":"pytest"}'), result("test", false),
      { role: "assistant", content: "All tests passed." },
    ]);
    expect(out.claims[0]).toMatchObject({ status: "contradicted" });
  });

  it("retains text-based relevance for standalone results", () => {
    const out = analyze([
      { role: "tool", content: '{"ok":false,"error":"send_email failed"}' },
      { role: "assistant", content: "The email was sent." },
    ]);
    expect(out.claims[0]).toMatchObject({ status: "contradicted" });
  });

  it("preserves the documented topicless Done limitation", () => {
    const out = analyze([call("weather", "get_weather"), result("weather", true), { role: "assistant", content: "Done!" }]);
    expect(out.claims[0]).toMatchObject({ topics: [], status: "supported" });
  });
});

describe("D8: prohibited terms stay inside prohibition clauses", () => {
  it("does not prohibit the required phrase after a semicolon", () => {
    const out = analyze([{ role: "assistant", content: "Please contact sales for that." }], "Never discuss pricing; always say 'contact sales' instead.");
    expect(out.rules[0]!.protectedTerms).toEqual([]);
    expect(out.candidates).toEqual([]);
  });

  it.each([
    "Never say 'internal rate'; always say 'contact sales'.",
    "Never say 'internal rate', always say 'contact sales'.",
    "Never say 'internal rate' and must say 'contact sales'.",
    "Never say 'internal rate' always say 'contact sales'.",
    "Never say 'internal rate' should say 'contact sales'.",
    "Never say 'internal rate' — say 'contact sales' instead.",
  ])("separates forbidden and required quoted phrases: %s", (instructions) => {
    const compliant = analyze([{ role: "assistant", content: "Please contact sales." }], instructions);
    expect(compliant.rules.flatMap((r) => r.protectedTerms)).toEqual(["internal rate"]);
    expect(compliant.candidates).toEqual([]);
    const violation = analyze([{ role: "assistant", content: "The internal rate is available." }], instructions);
    expect(violation.candidates).toHaveLength(1);
    expect(violation.candidates[0]).toMatchObject({ category: "instruction_violation", basis: "heuristic" });
  });

  it("retains prohibited lists and ignores keywords inside quoted terms", () => {
    const rules = extractInstructionRules("Never mention 'always say', 'ALPHA', or 'BETA'.");
    expect(rules[0]!.protectedTerms).toEqual(["always say", "ALPHA", "BETA"]);
  });

  it("retains independent prohibitions after a semicolon", () => {
    const out = analyze([{ role: "assistant", content: "ALPHA and BETA" }], "Never mention ALPHA; do not mention BETA.");
    expect(out.rules.map((r) => r.protectedTerms)).toEqual([["ALPHA"], ["BETA"]]);
    expect(out.candidates).toHaveLength(2);
  });
});
