import { describe, expect, it, vi } from "vitest";
import { createExpertSourcingApi, ExpertSourcingApiError, type ExpertSourcingApiDependencies } from "./expert-sourcing-api";
import type { Viewer } from "./access";
const id = "00000000-0000-4000-8000-000000000001";
const foreign = "00000000-0000-4000-8000-000000000002";
const owner: Viewer = { id, email: "owner@example.test", isOperator: false };
const operator: Viewer = { ...owner, isOperator: true };
function fixture(viewer: Viewer | null = owner) {
  let current = viewer;
  const deps: ExpertSourcingApiDependencies = {
    currentViewer: vi.fn(async () => current),
    disclosure: { version: "v1", text: "Paid experts receive bounded prompt context and factual questions for evaluation." },
    getSharingStatus: vi.fn(async ({ customerId }) => customerId === id ? { status: "not_consented", topic: null, eligibleTopics: ["medicine"] } : null),
    getPolicies: vi.fn(async () => []),
    issueConsent: vi.fn(async input => { if (await input.currentCustomer() !== id) throw new ExpertSourcingApiError(403, "Session changed"); }),
    revokeConsent: vi.fn(async () => {}),
    issuePolicy: vi.fn(async input => { if (await input.currentOperator() !== id) throw new ExpertSourcingApiError(403, "Operator required"); }),
    revokePolicy: vi.fn(async () => {}),
  };
  return { deps, api: createExpertSourcingApi(deps), setViewer: (v: Viewer | null) => { current = v; } };
}
const req = (body: unknown, headers: Record<string, string> = {}) => new Request("https://app.test/api/test", { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const consent = { action: "consent", consent: true, disclosureVersion: "v1", topic: "medicine" };
const policy = { action: "issue", tenantId: id, topic: "medicine", environment: "test", capsPolicyId: id, expiresAt: "2027-01-01T00:00:00Z" };
describe("authenticated sourcing API", () => {
  it("requires authentication and hides another customer's job even from an operator", async () => {
    expect((await fixture(null).api.customerGet(req({}), id)).status).toBe(401);
    const f = fixture({ ...operator, id: foreign });
    expect((await f.api.customerGet(req({}), id)).status).toBe(404);
    expect(f.deps.getSharingStatus).toHaveBeenCalledWith({ jobId: id, customerId: foreign });
  });
  it("returns only disclosure and safe current metadata with private headers", async () => {
    const f = fixture();
    vi.mocked(f.deps.getSharingStatus).mockResolvedValue({ status: "active", topic: "medicine", eligibleTopics: ["medicine"], secret: "must not escape" } as never);
    const response = await f.api.customerGet(req({}), id);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ disclosure: f.deps.disclosure, status: "active", topic: "medicine", eligibleTopics: ["medicine"] });
  });
  it.each([false, "true", 1, null, undefined])("never infers consent from %s", async value => {
    const f = fixture();
    expect((await f.api.customerPost(req({ ...consent, consent: value }), id)).status).toBe(400);
    expect(f.deps.issueConsent).not.toHaveBeenCalled();
  });
  it.each([{ issuer: id }, { canonicalInputDigest: "a".repeat(64) }, { tenantId: foreign }, { proposal: {} }])("rejects client authority fields %j", async extra => {
    expect((await fixture().api.customerPost(req({ ...consent, ...extra }), id)).status).toBe(400);
  });
  it("checks current disclosure and requires explicit selected topic", async () => {
    const f = fixture();
    expect((await f.api.customerPost(req({ ...consent, disclosureVersion: "old" }), id)).status).toBe(409);
    expect((await f.api.customerPost(req({ ...consent, topic: undefined }), id)).status).toBe(400);
    expect(f.deps.issueConsent).not.toHaveBeenCalled();
  });
  it("passes server identity and a fresh callback to atomic consent storage", async () => {
    const f = fixture();
    expect((await f.api.customerPost(req(consent), id)).status).toBe(200);
    const input = vi.mocked(f.deps.issueConsent).mock.calls[0][0];
    expect(input.customerId).toBe(id);
    expect(input).not.toHaveProperty("canonicalInputDigest");
    f.setViewer(null);
    expect(await input.currentCustomer()).toBeNull();
  });
  it("denies cross-origin, missing-origin, invalid MIME and oversized body", async () => {
    const f = fixture();
    for (const headers of [{ origin: "https://evil.test" }, { origin: "" }, { "sec-fetch-site": "cross-site" }]) expect((await f.api.customerPost(req(consent, headers), id)).status).toBe(403);
    expect((await f.api.customerPost(req(consent, { "content-type": "text/plain" }), id)).status).toBe(415);
    expect((await f.api.customerPost(req({ ...consent, topic: "a".repeat(5000) }), id)).status).toBe(413);
    expect(f.deps.issueConsent).not.toHaveBeenCalled();
  });
  it("revokes only the signed-in owner's job and describes the dispatch boundary", async () => {
    const f = fixture();
    expect((await f.api.customerPost(req({ action: "revoke" }), id)).status).toBe(200);
    expect(vi.mocked(f.deps.revokeConsent).mock.calls[0][0]).toMatchObject({ jobId: id, customerId: id });
  });
  it("allows operators to configure a standing topic once and rechecks their current status", async () => {
    const f = fixture(operator);
    expect((await f.api.operatorPost(req(policy))).status).toBe(200);
    const input = vi.mocked(f.deps.issuePolicy).mock.calls[0][0];
    expect(input).toMatchObject({ tenantId: id, topic: "medicine", maxRequirements: 36, maxContextChars: 16000 });
    expect(input).not.toHaveProperty("jobId");
    f.setViewer(owner);
    expect(await input.currentOperator()).toBeNull();
    expect((await f.api.operatorPost(req(policy))).status).toBe(403);
  });
  it("rejects operator identity forgery and unsupported envelopes", async () => {
    const f = fixture(operator);
    for (const extra of [{ issuedBy: id }, { jobId: id }, { maxRequirements: 37 }, { topic: "" }]) expect((await f.api.operatorPost(req({ ...policy, ...extra }))).status).toBe(400);
    expect(f.deps.issuePolicy).not.toHaveBeenCalled();
  });
  it("operator list is private, bounded, strict and excludes unknown columns", async () => {
    const f = fixture(operator);
    vi.mocked(f.deps.getPolicies).mockResolvedValue(Array.from({ length: 101 }, () => ({ id, topic: "medicine", environment: "test", status: "active", expiresAt: "2027-01-01", secret: "hidden" })));
    const response = await f.api.operatorGet(new Request(`https://app.test/api/operator/expert-sourcing?tenantId=${id}`));
    const data = await response.json();
    expect(data.policies).toHaveLength(100);
    expect(data.policies[0]).not.toHaveProperty("secret");
    expect((await f.api.operatorGet(new Request(`https://app.test/?tenantId=${id}&tenantId=${foreign}`))).status).toBe(400);
  });
  it("sanitizes unexpected storage failures", async () => {
    const f = fixture();
    vi.mocked(f.deps.issueConsent).mockRejectedValue(new Error("secret credential"));
    const response = await f.api.customerPost(req(consent), id);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("secret credential");
  });
  it("fails privately when fresh session lookup is unavailable", async () => {
    const f = fixture();
    vi.mocked(f.deps.currentViewer).mockRejectedValue(new Error("database password"));
    const response = await f.api.customerGet(req({}), id);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("password");
  });
  it("rejects revoked operator status when storage rechecks inside its mutation", async () => {
    const f = fixture(operator);
    vi.mocked(f.deps.currentViewer).mockResolvedValueOnce(operator).mockResolvedValue(owner);
    expect((await f.api.operatorPost(req(policy))).status).toBe(403);
  });
  it("operator revocation uses only policy identity and fresh operator callback", async () => {
    const f = fixture(operator);
    const response = await f.api.operatorPost(req({ action: "revoke", policyId: id, reason: "Owner revoked sourcing" }));
    expect(response.status).toBe(200);
    expect((await response.json()).boundary).toContain("began before revocation");
    const input = vi.mocked(f.deps.revokePolicy).mock.calls[0][0];
    f.setViewer(null);
    expect(await input.currentOperator()).toBeNull();
  });

});
