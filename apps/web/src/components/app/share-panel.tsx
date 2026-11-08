"use client";
import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "@/lib/client/api";
import { Button } from "@/components/ui";
import { Panel } from "./page-parts";

interface ShareStatus { enabled: boolean; createdAt?: string | null }
interface ShareEnabled { enabled: true; token: string; createdAt: string; url: string; badgeUrl: string; markdown: string }

/** Owner-only public share link for a delivered report. The token is only returned once, on enable. */
export function SharePanel({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [link, setLink] = useState<ShareEnabled | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await api<ShareStatus>(`/api/jobs/${jobId}/share`)); } catch (e) { setError(errMsg(e)); }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  async function set(enabled: boolean) {
    setBusy(true); setError(null);
    try {
      const r = await api<ShareEnabled | { enabled: false }>(`/api/jobs/${jobId}/share`, { method: "POST", json: { enabled } });
      if (r.enabled) { setLink(r); setStatus({ enabled: true, createdAt: r.createdAt }); }
      else { setLink(null); setStatus({ enabled: false }); }
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  async function copy(key: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1600); } catch { /* clipboard unavailable */ }
  }

  const on = status?.enabled === true;
  return (
    <Panel title="Share report" aside={status && <span className="t-data inline-flex items-center gap-2 text-subtle"><span aria-hidden className={`size-1.5 rounded-full ${on ? "bg-ok" : "bg-line-3"}`} />{on ? "Public link on" : "Private"}</span>}>
      <p className="max-w-[68ch] text-[15px] text-muted">Create a public, read-only link to a redacted copy of this report, plus a badge for your README. Anyone with the link can view it.</p>
      {link && (
        <div className="mt-5 space-y-4">
          <div>
            <div className="t-eyebrow mb-1.5 text-subtle">Public link</div>
            <div className="flex items-center gap-2">
              <input readOnly aria-label="Public share URL" value={link.url} onFocus={(e) => e.currentTarget.select()}
                className="h-9 min-w-0 flex-1 rounded-[4px] border border-line-2 bg-bg px-3 t-data text-fg-2 outline-none focus:border-accent" />
              <Button variant="outline" size="sm" onClick={() => copy("url", link.url)}>{copied === "url" ? "Copied" : "Copy"}</Button>
            </div>
          </div>
          <div>
            <div className="t-eyebrow mb-1.5 text-subtle">Badge</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={link.badgeUrl} alt="Report badge preview" height={20} className="h-5" />
          </div>
          <div>
            <div className="t-eyebrow mb-1.5 text-subtle">Markdown</div>
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-[4px] border border-line-2 bg-bg p-3 t-data text-fg-2">{link.markdown}</pre>
              <Button variant="outline" size="sm" onClick={() => copy("md", link.markdown)}>{copied === "md" ? "Copied" : "Copy"}</Button>
            </div>
          </div>
        </div>
      )}
      {on && !link && <p className="t-data mt-4 text-subtle">The link is shown only once, when created. Re-enable to get a new one.</p>}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        {on ? (
          <>
            <Button variant="outline" onClick={() => set(true)} disabled={busy}>{busy ? "Working…" : "Re-enable (new link)"}</Button>
            <Button variant="ghost" onClick={() => set(false)} disabled={busy}>Disable sharing</Button>
          </>
        ) : (
          <Button onClick={() => set(true)} disabled={busy || !status}>{busy ? "Creating…" : "Enable public link"}</Button>
        )}
      </div>
      {on && <p className="t-data mt-3 text-warn">Re-enabling rotates the link: the previous URL and badge stop working.</p>}
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    </Panel>
  );
}
