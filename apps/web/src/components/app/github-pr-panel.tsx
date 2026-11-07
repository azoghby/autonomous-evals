"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errMsg } from "@/lib/client/api";

interface Status {
  connected: boolean; owner?: string; repo?: string; baseBranch?: string; filePath?: string;
  prs: Record<string, string>;
}
export interface PrRemediation { id: string; summary: string; verificationStatus: "verified" | "partially_verified" | "not_verified" }

const newKey = () => crypto.randomUUID();
const input = "h-9 w-full rounded-[4px] border border-line-2 bg-bg px-3 text-fg outline-none placeholder:text-subtle focus:border-accent";
const btn = "h-9 rounded-[4px] border px-3 t-data transition-colors disabled:opacity-50";

/** Connect a repo (fine-grained PAT, one repo) and open one pull request per verified remediation. */
export function GithubPrPanel({ jobId, remediations }: { jobId: string; remediations: PrRemediation[] }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ owner: "", repo: "", baseBranch: "main", filePath: "", token: "" });

  const load = useCallback(async () => {
    try { setStatus(await api<Status>(`/api/jobs/${jobId}/github`)); } catch (e) { setError(errMsg(e)); }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy("connect"); setError(null);
    try {
      const next = await api<Status>(`/api/jobs/${jobId}/github`, { method: "POST", headers: { "Idempotency-Key": newKey() }, json: form });
      setStatus(next); setForm((f) => ({ ...f, token: "" }));
    } catch (err) { setError(errMsg(err)); } finally { setBusy(null); }
  }
  async function disconnect() {
    setBusy("disconnect"); setError(null);
    try { await api(`/api/jobs/${jobId}/github`, { method: "DELETE" }); await load(); } catch (err) { setError(errMsg(err)); } finally { setBusy(null); }
  }
  async function openPr(id: string) {
    setBusy(id); setError(null);
    try {
      const { prUrl } = await api<{ prUrl: string }>(`/api/jobs/${jobId}/remediations/${id}/pr`, { method: "POST", headers: { "Idempotency-Key": newKey() } });
      setStatus((s) => (s ? { ...s, prs: { ...s.prs, [id]: prUrl } } : s));
    } catch (err) { setError(errMsg(err)); } finally { setBusy(null); }
  }
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <section aria-labelledby="gh-pr-heading" className="rounded-[4px] border border-line-2 bg-bg p-5 text-fg">
      <h3 id="gh-pr-heading" className="t-data uppercase tracking-wide text-accent">Ship the fix as a pull request</h3>
      {error && <p role="alert" className="mt-3 border-l-2 border-accent pl-3 text-sm">{error}</p>}
      {!status ? <p className="mt-3 text-sm text-subtle">Loading...</p> : !status.connected ? (
        <form onSubmit={connect} className="mt-4 grid gap-3 sm:grid-cols-2">
          <input className={input} placeholder="owner" aria-label="GitHub owner" value={form.owner} onChange={set("owner")} required />
          <input className={input} placeholder="repository" aria-label="Repository" value={form.repo} onChange={set("repo")} required />
          <input className={input} placeholder="base branch" aria-label="Base branch" value={form.baseBranch} onChange={set("baseBranch")} required />
          <input className={input} placeholder="path/to/system-prompt.md" aria-label="File path" value={form.filePath} onChange={set("filePath")} required />
          <input className={`${input} sm:col-span-2`} type="password" autoComplete="off" placeholder="github_pat_... (fine-grained, one repo)" aria-label="Fine-grained access token" value={form.token} onChange={set("token")} required />
          <p className="text-xs text-subtle sm:col-span-2">Needs Contents and Pull requests write on this one repository. Stored encrypted and deleted with your job credentials.</p>
          <button type="submit" disabled={busy !== null} className={`${btn} border-accent bg-accent text-bg sm:col-span-2`}>{busy === "connect" ? "Checking access..." : "Connect repository"}</button>
        </form>
      ) : (
        <div className="mt-3">
          <p className="t-data text-sm">{status.owner}/{status.repo} <span className="text-subtle">@ {status.baseBranch} - {status.filePath}</span>
            <button onClick={disconnect} disabled={busy !== null} className="ml-3 text-subtle underline hover:text-fg">Disconnect</button></p>
          <ul className="mt-4 divide-y divide-line-2 border-y border-line-2">
            {remediations.map((r) => {
              const url = status.prs[r.id];
              const eligible = r.verificationStatus !== "not_verified";
              return (
                <li key={r.id} className="flex items-center justify-between gap-4 py-3">
                  <span className="text-sm">{r.summary}</span>
                  {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="t-data text-accent underline">View pull request</a>
                    : <button onClick={() => openPr(r.id)} disabled={!eligible || busy !== null} title={eligible ? undefined : "Only verified fixes can be shipped"}
                        className={`${btn} border-accent text-accent hover:bg-accent hover:text-bg`}>{busy === r.id ? "Opening..." : "Open PR"}</button>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
