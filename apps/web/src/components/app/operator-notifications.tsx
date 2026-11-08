"use client";
import { useState } from "react";
import { api, errMsg, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { Chip as UiChip, Frame, type ChipTone } from "@/components/ui";
import { Banner, Btn, Empty, ErrorBox, Field, Input, Loading, MarkLabel, Section, TableWrap, Th, tableCls, tdCls, trCls } from "./ui";

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "fyi";
interface NotifyApproval {
  id: string; seq: number; kind: string; title: string; summary: string; status: ApprovalStatus;
  decidedVia: string | null; decidedBy: string | null; decidedAt: string | null; createdAt: string;
  viewUrl: string; approveLabel: string | null; rejectLabel: string | null; error: string | null;
}
interface NotifyState {
  channels: {
    telegram: { configured: boolean; bound: boolean; botUsername: string | null; linkCode: string | null; linkCodeExpiresAt: string | null };
    whatsapp: { configured: boolean; to: string | null };
    email: { configured: boolean; recipients: number };
  };
  approvals: NotifyApproval[];
}
interface LinkResult { ok: true; linkCode: string; expiresAt: string; botUsername: string | null; deepLink: string | null }
interface TestResult { ok: true; results: Record<string, string> }
interface DecideResult { ok: true; status: string; note?: string }

const E164 = /^\+[1-9]\d{6,14}$/;
const STATUS_TONE: Record<ApprovalStatus, ChipTone> = { pending: "warn", approved: "ok", rejected: "danger", expired: "muted", fyi: "info" };
const SUMMARY_LIMIT = 120;
const linkCls = "text-fg-2 underline decoration-line-3 underline-offset-4 hover:text-accent-text hover:decoration-accent";

const post = <T,>(json: unknown) => api<T>("/api/operator/notify", { method: "POST", json });

function Card({ title, state, children }: { title: string; state: React.ReactNode; children: React.ReactNode }) {
  return (
    <Frame className="h-full p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <MarkLabel as="h3">{title}</MarkLabel>
        {state}
      </div>
      <div className="space-y-4 text-sm text-muted">{children}</div>
    </Frame>
  );
}

function NotConfigured({ vars, doc }: { vars: string[]; doc?: boolean }) {
  return (
    <p>Set {vars.map((v, i) => <span key={v}>{i > 0 && (i === vars.length - 1 ? " and " : ", ")}<code className="font-mono text-xs text-fg-2">{v}</code></span>)}
      {doc && " (see docs/FOUNDER_APPROVALS.md)"}.</p>
  );
}

function TelegramCard({ tg, onChanged }: { tg: NotifyState["channels"]["telegram"]; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkResult | null>(null);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name); setError(null);
    try { await fn(); } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }
  const generate = () => run("gen", async () => { setLink(await post<LinkResult>({ action: "telegram_link" })); await onChanged(); });
  const unlink = () => run("unlink", async () => { await post({ action: "telegram_unlink" }); setLink(null); await onChanged(); });
  const refresh = () => run("refresh", onChanged);

  const code = link?.linkCode ?? tg.linkCode;
  const expires = link?.expiresAt ?? tg.linkCodeExpiresAt;
  const bot = link?.botUsername ?? tg.botUsername;
  const deepLink = link?.deepLink ?? null;

  return (
    <Card title="Telegram" state={!tg.configured ? <UiChip tone="muted">Not configured</UiChip> : tg.bound ? <UiChip tone="ok">Linked</UiChip> : <UiChip tone="warn">Not linked</UiChip>}>
      {!tg.configured ? <NotConfigured vars={["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]} doc /> : tg.bound ? (
        <>
          <p>Approval requests are delivered to your linked Telegram chat with inline buttons.</p>
          <Btn variant="ghost" size="sm" onClick={() => void unlink()} loading={busy === "unlink"} disabled={busy !== null}>Unlink</Btn>
        </>
      ) : (
        <>
          {code ? (
            <div className="space-y-2">
              <div className="font-mono text-2xl tracking-widest text-fg" aria-label="Link code">{code}</div>
              <p>Open Telegram, message {bot ? <span className="text-fg-2">@{bot}</span> : "the bot"} and send: <code className="font-mono text-xs text-fg-2">/start {code}</code></p>
              {deepLink && <a href={deepLink} target="_blank" rel="noopener noreferrer" className={linkCls}>Open in Telegram</a>}
              {expires && <p className="text-xs text-subtle">Expires {when(expires)}</p>}
            </div>
          ) : <p>Generate a one-time code to link your Telegram account.</p>}
          <div className="flex flex-wrap gap-2">
            <Btn size="sm" onClick={() => void generate()} loading={busy === "gen"} disabled={busy !== null}>{code ? "New link code" : "Generate link code"}</Btn>
            <Btn variant="ghost" size="sm" onClick={() => void refresh()} loading={busy === "refresh"} disabled={busy !== null}>Refresh</Btn>
          </div>
        </>
      )}
      {error && <Banner tone="bad">{error}</Banner>}
    </Card>
  );
}

function WhatsAppCard({ wa, onChanged }: { wa: NotifyState["channels"]["whatsapp"]; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function save(to: string | null) {
    if (to !== null && !E164.test(to)) { setError("Use E.164 format, e.g. +14155551234."); return; }
    setBusy(to === null ? "clear" : "save"); setError(null); setDone(null);
    try {
      await post({ action: "set_whatsapp", to });
      setValue(""); setDone(to === null ? "Number cleared." : "Number saved.");
      await onChanged();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(null); }
  }

  return (
    <Card title="WhatsApp" state={!wa.configured ? <UiChip tone="muted">Not configured</UiChip> : wa.to ? <UiChip tone="ok">Number set</UiChip> : <UiChip tone="warn">No number</UiChip>}>
      {!wa.configured && <NotConfigured vars={["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"]} />}
      <p>Current number: <span className="font-mono text-xs text-fg-2">{wa.to ?? "none"}</span></p>
      <form onSubmit={(e) => { e.preventDefault(); void save(value.trim()); }} className="space-y-3">
        <Field label="Founder WhatsApp number (E.164)" error={error ?? undefined}>
          <Input type="tel" inputMode="tel" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="+14155551234" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Btn type="submit" size="sm" loading={busy === "save"} disabled={busy !== null || !value.trim()}>Save</Btn>
          <Btn type="button" variant="ghost" size="sm" onClick={() => void save(null)} loading={busy === "clear"} disabled={busy !== null || !wa.to}>Clear</Btn>
        </div>
      </form>
      <p aria-live="polite" className="text-xs text-ok">{done}</p>
    </Card>
  );
}

function EmailCard({ email }: { email: NotifyState["channels"]["email"] }) {
  return (
    <Card title="Email" state={email.configured ? <UiChip tone="ok">Configured</UiChip> : <UiChip tone="muted">Not configured</UiChip>}>
      <p>Fallback channel, used when Telegram and WhatsApp are unavailable.</p>
      <p><span className="font-mono text-fg-2">{email.recipients}</span> {email.recipients === 1 ? "recipient" : "recipients"}</p>
    </Card>
  );
}

function TestSection({ onTested }: { onTested: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string> | null>(null);

  async function send() {
    setBusy(true); setError(null);
    try { setResults((await post<TestResult>({ action: "test" })).results); await onTested(); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <Btn variant="ghost" onClick={() => void send()} loading={busy} disabled={busy}>Send test message</Btn>
      <div aria-live="polite">
        {error && <Banner tone="bad">{error}</Banner>}
        {results && (
          <ul className="divide-y divide-line text-sm">
            {Object.entries(results).map(([ch, r]) => (
              <li key={ch} className="flex min-h-10 items-center justify-between gap-3 py-2">
                <span className="capitalize text-fg-2">{ch}</span>
                <UiChip tone={r === "sent" ? "ok" : r.startsWith("error") ? "danger" : "muted"}>{r}</UiChip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ApprovalRow({ a, busyKey, onDecide }: { a: NotifyApproval; busyKey: string | null; onDecide: (id: string, d: "approve" | "reject") => void }) {
  const [open, setOpen] = useState(false);
  const long = a.summary.length > SUMMARY_LIMIT;
  const summary = open || !long ? a.summary : `${a.summary.slice(0, SUMMARY_LIMIT)}…`;
  const decidable = a.status === "pending" && a.approveLabel;
  return (
    <tr className={`${trCls} align-top`}>
      <td className={`${tdCls} py-3 font-mono text-xs text-subtle`}>#{a.seq}</td>
      <td className={`${tdCls} py-3 text-muted`}>{a.kind}</td>
      <td className="min-w-[260px] max-w-[420px] px-4 py-3 align-top">
        <div className="text-fg">{a.title}</div>
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{summary}
          {long && <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={`ml-2 ${linkCls}`}>{open ? "Less" : "More"}</button>}
        </p>
        {a.error && <p className="mt-1 text-xs text-danger">{a.error}</p>}
      </td>
      <td className={`${tdCls} py-3`}><UiChip tone={STATUS_TONE[a.status] ?? "muted"}>{a.status}</UiChip></td>
      <td className={`${tdCls} py-3 text-xs text-subtle`}>{a.decidedAt ? `${a.decidedVia ?? "unknown"} · ${when(a.decidedAt)}` : "-"}</td>
      <td className={`${tdCls} py-3`}>
        <div className="flex items-center gap-2">
          {decidable && <Btn size="sm" onClick={() => onDecide(a.id, "approve")} loading={busyKey === `${a.id}approve`} disabled={busyKey !== null}>{a.approveLabel}</Btn>}
          {decidable && a.rejectLabel && <Btn size="sm" variant="danger" onClick={() => onDecide(a.id, "reject")} loading={busyKey === `${a.id}reject`} disabled={busyKey !== null}>{a.rejectLabel}</Btn>}
          <a href={a.viewUrl} target="_blank" rel="noopener noreferrer" className={`text-sm ${linkCls}`}>View</a>
        </div>
      </td>
    </tr>
  );
}

function ApprovalsSection({ approvals, onChanged }: { approvals: NotifyApproval[]; onChanged: () => Promise<void> }) {
  const [filter, setFilter] = useState<"all" | "pending">("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyKey(id + decision); setError(null); setNote(null);
    try {
      const r = await post<DecideResult>({ action: "decide", id, decision });
      setNote(r.note ?? `Marked ${r.status}.`);
      await onChanged();
    } catch (e) { setError(errMsg(e)); } finally { setBusyKey(null); }
  }

  const rows = filter === "pending" ? approvals.filter((a) => a.status === "pending") : approvals;
  const filterBtn = (f: "all" | "pending", label: string) => (
    <Btn size="sm" variant={filter === f ? "primary" : "ghost"} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</Btn>
  );

  return (
    <Section title="Approvals" aside={<div role="group" aria-label="Filter approvals" className="flex gap-2">{filterBtn("all", "All")}{filterBtn("pending", "Pending")}</div>}>
      <div aria-live="polite" className="space-y-2">
        {error && <ErrorBox message={error} />}
        {note && <Banner tone="ok">{note}</Banner>}
      </div>
      <TableWrap>
        {rows.length === 0 ? <Empty title={filter === "pending" ? "Nothing pending" : "No approvals yet"} body="Approval requests sent to your channels appear here." /> : (
          <table className={`${tableCls} min-w-[820px]`}>
            <thead><tr><Th>#</Th><Th>Kind</Th><Th>Request</Th><Th>Status</Th><Th>Decided</Th><Th>Actions</Th></tr></thead>
            <tbody>{rows.map((a) => <ApprovalRow key={a.id} a={a} busyKey={busyKey} onDecide={(id, d) => void decide(id, d)} />)}</tbody>
          </table>
        )}
      </TableWrap>
    </Section>
  );
}

/** Operator-only notifications panel (GET/POST /api/operator/notify). */
export function OperatorNotifications() {
  const { data, error, loading, reload } = useFetch<NotifyState>("/api/operator/notify");

  if (loading) return <Loading label="Loading notifications" />;
  if (error?.status === 403) return null;
  if (error || !data) return <ErrorBox message={error?.message ?? "Unknown error"} onRetry={() => void reload()} />;

  const { channels } = data;
  return (
    <div className="space-y-14">
      <Section title="Channels">
        <div className="grid gap-6 lg:grid-cols-3">
          <TelegramCard tg={channels.telegram} onChanged={reload} />
          <WhatsAppCard wa={channels.whatsapp} onChanged={reload} />
          <EmailCard email={channels.email} />
        </div>
        <TestSection onTested={reload} />
      </Section>
      <ApprovalsSection approvals={data.approvals} onChanged={reload} />
    </div>
  );
}
