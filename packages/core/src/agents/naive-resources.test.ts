import { describe, expect, it, vi } from "vitest";
import { buildCredentialOperation, buildOutcomeOperation, buildSkillOperation, discoverResource, type ResourceClientFactory } from "./naive-resources";
const page = <T>(data: T[]) => ({ data, has_more: false, next_cursor: null });
const factory = (value: unknown) => (() => value) as ResourceClientFactory;
describe("Naive resource safety", () => {
  it.each([
    { data: [], next_cursor: null },
    { data: [], has_more: 0, next_cursor: null },
    { data: [], has_more: false, next_cursor: "unexpected" },
    { data: [], has_more: true, next_cursor: null },
    { data: Array.from({ length: 101 }, (_, i) => ({ id: String(i) })), has_more: false, next_cursor: null },
  ])("rejects malformed pagination before inferring absence: %j", async malformed => {
    await expect(discoverResource(async () => malformed as never, () => false)).rejects.toThrow("inspection_failed");
  });
  it("does not infer absence from repeated cursors", async () => {
    await expect(discoverResource(async () => ({ data: [], has_more: true, next_cursor: "same" }), () => true)).rejects.toThrow("inspection_failed");
  });
  it("rejects duplicate identities across pages", async () => {
    await expect(discoverResource(async () => ({ data: [{ id: "x" }], has_more: true, next_cursor: "next" }), () => false)).rejects.toThrow("inspection_failed");
  });
  it("rejects multiple name matches", async () => {
    await expect(discoverResource(async () => page([{ id: "a" }, { id: "b" }]), () => true)).rejects.toThrow("inspection_failed");
  });
  it("reads later pages before returning a match", async () => {
    const list = vi.fn().mockResolvedValueOnce({ data: [{ id: "a" }], has_more: true, next_cursor: "cursor" }).mockResolvedValueOnce(page([]));
    expect(await discoverResource(list, () => true)).toEqual({ id: "a" });
    expect(list).toHaveBeenLastCalledWith({ limit: 100, after: "cursor" });
  });
  it("rejects skill content drift without pushing a new version", async () => {
    const push = vi.fn();
    const op = buildSkillOperation(factory({ skills: { get: async () => ({ id: "skl_a", name: "rules", latest_version: 1, description: "" }), getVersion: async () => ({ content: "changed" }), push } }), { slug: "rules", content: "original" });
    await expect(op.attest({ id: "skl_a", version: 1 })).rejects.toThrow("configuration_drift");
    expect(push).not.toHaveBeenCalled();
  });
  it("rejects outcome rubric drift", async () => {
    const expected = { name: "quality", description: "d", rubric: "r", max_iterations: 2 };
    const op = buildOutcomeOperation(factory({ outcomes: { get: async () => ({ ...expected, id: "ocm_a", rubric: "changed", rubric_file: null }) } }), expected);
    await expect(op.attest({ id: "ocm_a" })).rejects.toThrow("configuration_drift");
  });
  it("does not treat credential metadata as proof of secret value", async () => {
    const secret = "private-test-value";
    const op = buildCredentialOperation(factory({}), "vlt_a", { kind: "static_bearer", key: "role", value: secret, agent_id: "agt_a", mcp_server_url: "https://example.com/mcp" });
    expect(op.fingerprint).not.toContain(secret);
    await expect(op.attest({ id: "cred_a" })).rejects.toThrow("configuration_drift");
  });
  it("snapshots desired outcome fields before asynchronous creation", async () => {
    const create = vi.fn(async () => ({ id: "ocm_a" }));
    const desired = { name: "quality", description: "original", rubric: "r", max_iterations: 2 };
    const op = buildOutcomeOperation(factory({ outcomes: { create } }), desired);
    desired.description = "mutated";
    await op.create("key");
    expect(create).toHaveBeenCalledWith({ name: "quality", description: "original", rubric: "r", max_iterations: 2 });
  });
  it("requires agent-bound bearer credentials", () => {
    expect(() => buildCredentialOperation(factory({}), "vlt_a", { kind: "static_bearer", key: "role", value: "secret", mcp_server_url: "https://example.com/mcp" })).toThrow("configuration_drift");
  });
  it("uses the provided operation key for outcome creation", async () => {
    const create = vi.fn(async () => ({ id: "ocm_a" }));
    const client = vi.fn(() => ({ outcomes: { create } })) as unknown as ResourceClientFactory;
    const op = buildOutcomeOperation(client, { name: "quality", description: "d", rubric: "r", max_iterations: 2 });
    expect(await op.create("durable-key")).toEqual({ id: "ocm_a" });
    expect(client).toHaveBeenCalledWith("durable-key");
  });
});
