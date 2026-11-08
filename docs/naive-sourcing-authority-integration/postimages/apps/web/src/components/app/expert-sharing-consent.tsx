"use client";
import { useEffect, useState } from "react";
import { Btn, Section } from "./ui";

type Status = { disclosure: { version: string; text: string }; status: "not_consented" | "active" | "revoked" | "expired" | "input_changed"; topic: string | null; eligibleTopics: string[] };
const labels: Record<Status["status"], string> = { not_consented: "Sharing is off", active: "Sharing is enabled", revoked: "Sharing was revoked", expired: "Sharing authorization expired", input_changed: "Your evaluation changed; previous sharing authorization no longer applies" };
export function ExpertSharingConsent({ jobId }: { jobId: string }) {
  const [state, setState] = useState<Status | null>(null);
  const [topic, setTopic] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const url = `/api/jobs/${encodeURIComponent(jobId)}/expert-sharing`;
  async function load(signal?: AbortSignal) {
    const response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok) throw Error("Unable to load expert sharing settings.");
    const data: Status = await response.json();
    setState(data); setTopic(data.topic ?? (data.eligibleTopics.length === 1 ? data.eligibleTopics[0]! : "")); setAccepted(false);
  }
  useEffect(() => { const controller = new AbortController(); setState(null); setError(""); setNotice(""); void load(controller.signal).catch(() => { if (!controller.signal.aborted) setError("Unable to load expert sharing settings."); }); return () => controller.abort(); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  async function mutate(action: "consent" | "revoke") {
    if (!state) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const body = action === "consent" ? { action, consent: accepted, disclosureVersion: state.disclosure.version, topic } : { action };
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw Error("Unable to update sharing. Refresh the settings and try again.");
      const result = await response.json();
      setState(null);
      setNotice(result.boundary ?? "Sharing preference saved.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to update sharing."); }
    finally { setBusy(false); }
  }
  if (state?.status === "not_consented" && !state.eligibleTopics.length) return null;
  return <div className="mt-8"><Section title="Expert data sharing">
    {error && <p role="alert" className="text-sm text-danger">{error} <button type="button" className="underline" disabled={busy} onClick={() => { setError(""); void load().catch(() => setError("Unable to load expert sharing settings.")); }}>Refresh settings</button></p>}
    {!state && !error && <p role="status" className="text-sm text-muted">Loading sharing settings…</p>}
    {state && <>
      <p className="text-sm text-fg">{labels[state.status]}{state.topic ? ` · ${state.topic}` : ""}</p>
      <p id={`expert-disclosure-${jobId}`} className="max-w-2xl text-sm leading-relaxed text-muted">{state.disclosure.text}</p>
      {state.status === "not_consented" && state.eligibleTopics.length > 0 && <form className="max-w-xl space-y-4" onSubmit={e => { e.preventDefault(); void mutate("consent"); }}>
        <label className="block text-sm">Expertise topic<select className="mt-2 block w-full rounded-[4px] border border-line-2 bg-bg p-2 text-fg focus-visible:outline-accent" value={topic} required disabled={busy} onChange={e => { setTopic(e.target.value); setAccepted(false); }}><option value="">Select a topic</option>{state.eligibleTopics.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)} aria-describedby={`expert-disclosure-${jobId}`} />I agree to the expert sharing described above for this evaluation.</label>
        <Btn type="submit" loading={busy} disabled={!accepted || !topic}>Enable expert sharing</Btn>
      </form>}
      {state.status !== "not_consented" && state.status !== "revoked" && <Btn type="button" variant="ghost" loading={busy} onClick={() => void mutate("revoke")}>Revoke future sharing</Btn>}
      {["revoked", "expired", "input_changed"].includes(state.status) && <p className="text-sm text-muted">This authorization cannot be renewed. Start a new evaluation to give new consent.</p>}
    </>}
    {notice && <p role="status" className="text-sm text-muted">{notice}</p>}
  </Section></div>;
}
