import { describe, expect, it, vi } from "vitest";
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { diagnosticPolicy, type DiagnosticPolicyInput } from "./live-diagnostic-policy";
import { runLiveDiagnostic } from "./live-diagnostic";
import { ensureAgents } from "./provision";
vi.mock("./provision", () => ({ ensureAgents: vi.fn() }));
const input = (): DiagnosticPolicyInput => ({
  runId: "phase0-test", budgetPeriodId: "2026-11", stateFile: "/unused/diagnostic.json",
  directory: {
    commercial: { agentId: `agt_${"0".repeat(26)}`, agentVersion: 1 },
    evaluation_engineer: { agentId: `agt_${"1".repeat(26)}`, agentVersion: 2 },
    quality_investigator: { agentId: `agt_${"2".repeat(26)}`, agentVersion: 3 },
    company_operator: { agentId: `agt_${"3".repeat(26)}`, agentVersion: 4 },
  },
});
describe("live diagnostic authorization policy", () => {
  it("uses the plan's quarter-dollar sessions and one-dollar aggregate, preserving lower explicit limits", () => {
    expect(diagnosticPolicy(input())).toMatchObject({ per: 250_000, total: 1_000_000, budgetPeriodId: "2026-11" });
    expect(diagnosticPolicy({ ...input(), perSessionMicroUsd: 100_000, totalMicroUsd: 400_000 })).toMatchObject({ per: 100_000, total: 400_000 });
  });
  it.each([
    { perSessionMicroUsd: 0 }, { perSessionMicroUsd: -1 }, { perSessionMicroUsd: NaN },
    { perSessionMicroUsd: 0.5 }, { perSessionMicroUsd: 300_000 },
    { totalMicroUsd: 999_999 }, { totalMicroUsd: 1_200_000 }, { totalMicroUsd: Infinity },
    { budgetPeriodId: "" }, { runId: "../escape" }, { stateFile: "" }, { maxWaitMs: 0 },
    { provision: true }, { provision: "yes" }, { directory: undefined },
  ])("refuses invalid policy before any provider call: %j", async change => {
    vi.mocked(ensureAgents).mockClear();
    await expect(runLiveDiagnostic({ ...input(), ...change, client: {} as VettaClient } as any)).rejects.toThrow("Invalid live diagnostic policy");
    expect(ensureAgents).not.toHaveBeenCalled();
  });
  it("requires each exact version and distinct valid role identity", () => {
    for (const change of [undefined, 0, 1.5, NaN]) {
      const value = input(); (value.directory.commercial as any).agentVersion = change;
      expect(() => diagnosticPolicy(value)).toThrow();
    }
    const value = input(); value.directory.commercial.agentId = value.directory.company_operator.agentId;
    expect(() => diagnosticPolicy(value)).toThrow();
  });
  it("snapshots all role pins before asynchronous provider attestation", () => {
    const value = input(), policy = diagnosticPolicy(value);
    value.directory.commercial.agentVersion = 99;
    expect(policy.directory.commercial.agentVersion).toBe(1);
  });
  it("only invokes read-only pinned attestation, even when provision:false is passed", async () => {
    vi.mocked(ensureAgents).mockRejectedValueOnce(new Error("attestation refused"));
    const value = input(), client = {} as VettaClient;
    await expect(runLiveDiagnostic({ ...value, provision: false, client })).rejects.toThrow("attestation refused");
    expect(ensureAgents).toHaveBeenLastCalledWith(client, { model: undefined, dryRun: true, directory: value.directory });
  });
});
