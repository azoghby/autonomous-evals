"use client";
import { useState } from "react";
import { Btn, Field, Input, Section } from "./ui";
type Policy = { id: string; topic: string; environment: string; status: string; expiresAt: string };
export function OperatorExpertSourcing() {
  const [tenantId, setTenant] = useState(""); const [topic, setTopic] = useState(""); const [capsPolicyId, setCaps] = useState("");
  const [environment, setEnvironment] = useState("test"); const [expiresAt, setExpiry] = useState("");
  const [policies, setPolicies] = useState<Policy[] | null>(null); const [listedTenant, setListedTenant] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [reason, setReason] = useState("");
  const [revokeId, setRevokeId] = useState("");
  const url = "/api/operator/expert-sourcing";
  async function list(tenant: string) {
    const response = await fetch(`${url}?tenantId=${encodeURIComponent(tenant)}`, { cache: "no-store" });
    if (!response.ok) throw Error("Unable to load policies. Check the customer ID and operator access.");
    const data = await response.json(); setPolicies(data.policies); setListedTenant(tenant);
  }
  async function run(work: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Unable to update policy."); } finally { setBusy(false); } }
  async function mutate(body: Record<string, unknown>, tenant: string) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw Error("Policy change was not accepted. Refresh and check the configuration.");
    const result = await response.json(); setNotice(result.boundary ?? "Standing policy saved."); await list(tenant);
  }
  return <div className="max-w-3xl space-y-8"><h1 className="t-h1">Expert sourcing policies</h1>
    <p className="text-sm leading-relaxed text-muted">Configure an exact customer, environment and expertise topic once. Eligible future evaluations can invite opted-in experts after the customer gives sharing consent. New cold contacts still require approval.</p>
    <p className="text-sm text-muted">Existing spending limits remain $25 per evaluation and $50 per day. This form cannot raise them. Each grant lasts at most seven days and ends sooner when consent or this policy expires.</p>
    <Section title="Customer policies"><form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); void run(() => list(tenantId.trim())); }}>
      <Field label="Customer ID"><Input required value={tenantId} disabled={busy} onChange={e => { setTenant(e.target.value); setPolicies(null); }} placeholder="Customer UUID" /></Field>
      <Btn type="submit" variant="ghost" loading={busy}>Load policies</Btn>
    </form>
    {policies && <div className="space-y-4"><p className="text-sm text-muted">Showing up to 100 newest policies. Older policies can be revoked by their policy ID below.</p>{policies.length === 0 && <p className="text-sm text-muted">No policies for this customer.</p>}
      {policies.length > 0 && <Field label="Reason for revocation"><Input maxLength={500} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></Field>}
      {policies.map(p => <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line-2 py-3"><div><p>{p.topic} · {p.environment}</p><p className="break-all font-mono text-xs text-muted">{p.id}</p><p className="text-sm text-muted">{p.status} · expires {new Date(p.expiresAt).toLocaleString()}</p></div>{p.status !== "revoked" && <Btn type="button" variant="ghost" disabled={busy || !reason.trim()} onClick={() => void run(() => mutate({ action: "revoke", policyId: p.id, reason: reason.trim() }, listedTenant))}>Revoke policy</Btn>}</div>)}
    </div>}</Section>
    <Section title="New standing policy"><form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(async () => { if (!tenantId.trim()) throw Error("Enter a customer ID first."); await mutate({ action: "issue", tenantId: tenantId.trim(), topic: topic.trim(), capsPolicyId: capsPolicyId.trim(), environment, expiresAt: new Date(expiresAt).toISOString(), maxRequirements: 36, maxContextChars: 16000, grantLifetimeSeconds: 604800 }, tenantId.trim()); }); }}>
      <Field label="Expertise topic"><Input required maxLength={160} disabled={busy} value={topic} onChange={e => setTopic(e.target.value)} /></Field>
      <Field label="Existing spending policy ID"><Input required maxLength={120} disabled={busy} value={capsPolicyId} onChange={e => setCaps(e.target.value)} /></Field>
      <label className="block text-sm">Environment<select className="mt-2 block rounded-[4px] border border-line-2 bg-bg p-2 text-fg" disabled={busy} value={environment} onChange={e => setEnvironment(e.target.value)}><option value="test">Test</option><option value="live">Live</option></select></label>
      <Field label="Policy expiry (your local time)"><Input type="datetime-local" required disabled={busy} value={expiresAt} onChange={e => setExpiry(e.target.value)} /></Field>
      <p className="text-sm text-muted">The sharing envelope allows up to 36 factual requirements and 16,000 characters of system-prompt context. Policy records are immutable; revocation blocks future dispatch and cannot recall started messages.</p>
      <Btn type="submit" loading={busy} disabled={!tenantId.trim()}>Create standing policy</Btn>
    </form></Section>
    <Section title="Revoke by policy ID"><form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(async () => { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke", policyId: revokeId.trim(), reason: reason.trim() }) }); if (!response.ok) throw Error("Revocation was not accepted. Check the policy ID and operator access."); const result = await response.json(); setNotice(result.boundary); setPolicies(null); }); }}>
      <Field label="Policy ID"><Input required disabled={busy} value={revokeId} onChange={e => setRevokeId(e.target.value)} placeholder="Policy UUID" /></Field>
      <Field label="Revocation reason"><Input required maxLength={500} disabled={busy} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <Btn type="submit" variant="ghost" loading={busy} disabled={!revokeId.trim() || !reason.trim()}>Revoke this policy</Btn>
    </form></Section>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm text-muted">{notice}</p>}
  </div>;
}
