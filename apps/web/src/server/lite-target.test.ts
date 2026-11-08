import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./job-store", () => ({ getJobWithDecryptedCredentials: vi.fn() }));
import type { IntakeInput } from "@ae/core/contracts/index";
import { liteTargetFromIntake } from "./lite-target";

const ep = { url: "https://api.example.com/v1/chat/completions", model: "m", apiKey: "sk-secret-1", systemPrompt: "SYS" };
const as = (x: unknown) => x as IntakeInput;

describe("liteTargetFromIntake", () => {
  it("maps endpoint for text_eval and endpointB for version_comparison", () => {
    expect(liteTargetFromIntake(as({ package: "text_eval", endpoint: ep }))).toEqual(ep);
    expect(liteTargetFromIntake(as({ package: "version_comparison", endpointA: { ...ep, model: "a" }, endpointB: ep }))?.model).toBe("m");
  });
  it("returns null when the intake has no endpoint", () => {
    expect(liteTargetFromIntake(as({ package: "trace_audit", trace: "t" }))).toBeNull();
  });
  it("defaults a missing system prompt to empty", () => {
    expect(liteTargetFromIntake(as({ package: "text_eval", endpoint: { ...ep, systemPrompt: undefined } }))?.systemPrompt).toBe("");
  });
});
