"use client";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { api, errMsg, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { Button, Chip, CodeBlock, Eyebrow, EmptyState, ErrorState, Field, Frame, Spinner } from "@/components/ui";
import { MarkLabel, TableWrap, Th, tableCls, tdCls, trCls } from "./ui";

const FALLBACK_ORIGIN = "https://standard-evals.vercel.app";
const PLACEHOLDER_KEY = "<your-key>";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
interface CreatedKey { id: string; prefix: string; key: string }

const subscribe = () => () => {};
function useOrigin(): string {
  return useSyncExternalStore(subscribe, () => window.location.origin, () => FALLBACK_ORIGIN);
}

function CopyButton({ text, label, variant = "outline" }: { text: string; label: string; variant?: "outline" | "quiet" }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }
  return (
    <Button variant={variant} size="sm" onClick={copy} aria-label={`Copy ${label}`}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </Button>
  );
}

function McpSnippets({ origin, apiKey }: { origin: string; apiKey: string }) {
  const url = `${origin}/api/mcp/mcp`;
  const json = JSON.stringify({ mcpServers: { "standard-evals": { url, headers: { Authorization: `Bearer ${apiKey}` } } } }, null, 2);
  const cli = `claude mcp add --transport http standard-evals ${url} --header "Authorization: Bearer ${apiKey}"`;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <CodeBlock label="MCP config (JSON)" code={json} />
      <CodeBlock label="Claude Code" code={cli} />
    </div>
  );
}

function KeyRow({ k, onChanged }: { k: ApiKeyRow; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const revoked = k.revokedAt !== null;
  return (
    <tr className={`${trCls} ${revoked ? "text-subtle" : ""}`}>
      <td className={`${tdCls} max-w-[240px]`}>
        <div className={`truncate ${revoked ? "line-through decoration-line-3" : "text-fg"}`} title={k.name}>{k.name}</div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </td>
      <td className={`${tdCls} font-mono text-[13px]`}>{k.prefix}…</td>
      <td className={`${tdCls} whitespace-nowrap font-mono text-[13px] text-muted`}>{when(k.createdAt)}</td>
      <td className={`${tdCls} whitespace-nowrap font-mono text-[13px] text-muted`}>{k.lastUsedAt ? when(k.lastUsedAt) : "Never"}</td>
      <td className={`${tdCls} text-right`}>
        {revoked ? (
          <Chip tone="muted" variant="plain">Revoked</Chip>
        ) : confirming ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-[13px] text-muted">Revoke this key?</span>
            <Button variant="outline" size="sm" onClick={revoke} disabled={busy} className="text-danger" aria-label={`Confirm revoke ${k.name}`}>{busy ? "Revoking…" : "Revoke"}</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} className="hover:text-danger" aria-label={`Revoke ${k.name}`}>Revoke</Button>
        )}
      </td>
    </tr>
  );
}

export function ApiKeys() {
  const origin = useOrigin();
  const { data, error, loading, reload } = useFetch<{ keys: ApiKeyRow[] }>("/api/keys");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(CreatedKey & { name: string }) | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setNameError("Give the key a name, e.g. “Claude Code on my laptop”."); return; }
    setNameError(null);
    setCreating(true);
    try {
      const r = await api<CreatedKey>("/api/keys", { method: "POST", json: { name: trimmed } });
      setCreated({ ...r, name: trimmed });
      setName("");
      await reload();
    } catch (err) {
      setNameError(errMsg(err));
    } finally {
      setCreating(false);
    }
  }

  const signedOut = error?.status === 401;
  const keys = data?.keys ?? [];

  return (
    <div className="space-y-14">
      <header>
        <Eyebrow className="mb-4">Settings</Eyebrow>
        <h1 className="t-h1">API keys</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-muted">Let AI agents hire Standard Evals over MCP.</p>
      </header>

      {signedOut ? (
        <p className="border-t border-line-2 pt-6 text-muted">
          You are signed out. <a className="text-fg underline decoration-line-3 underline-offset-4 hover:decoration-accent" href="/signin?next=/settings/keys">Sign in</a> to manage API keys.
        </p>
      ) : (
        <>
          <section aria-labelledby="create-key" className="space-y-4 border-t border-line-2 pt-6">
            <MarkLabel><span id="create-key">Create a key</span></MarkLabel>
            <Frame className="p-5 sm:p-6">
              <form onSubmit={create} noValidate className="flex max-w-2xl flex-col gap-4 sm:flex-row sm:items-end">
                <Field
                  id="key-name" label="Name" className="flex-1" placeholder="Claude Code on my laptop" maxLength={80}
                  autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} error={nameError ?? undefined}
                />
                <Button type="submit" disabled={creating}>{creating ? "Creating…" : "Create key"}</Button>
              </form>
            </Frame>
          </section>

          {created && (
            <section aria-labelledby="new-key" className="space-y-6 border-t border-accent pt-6">
              <div className="space-y-3">
                <MarkLabel><span id="new-key">New key</span></MarkLabel>
                <h2 className="t-h3">{created.name}</h2>
                <p role="status" className="text-sm text-warn">Copy it now. This key will not be shown again.</p>
                <div className="flex flex-wrap items-center gap-3 rounded-[4px] border border-line-2 bg-bg-raised p-3">
                  <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-fg select-all">{created.key}</code>
                  <CopyButton text={created.key} label="API key" />
                </div>
              </div>
              <McpSnippets origin={origin} apiKey={created.key} />
              <Button variant="quiet" onClick={() => setCreated(null)}>I have saved my key</Button>
            </section>
          )}

          {!created && (
            <section aria-labelledby="connect" className="space-y-4 border-t border-line-2 pt-6">
              <MarkLabel><span id="connect">Connect an agent</span></MarkLabel>
              <McpSnippets origin={origin} apiKey={PLACEHOLDER_KEY} />
            </section>
          )}

          <section aria-labelledby="your-keys" className="space-y-4 border-t border-line-2 pt-6">
            <MarkLabel><span id="your-keys">Your keys</span></MarkLabel>
            {loading ? (
              <div className="flex items-center gap-3 py-8 text-sm text-muted"><Spinner size={16} /> Loading keys…</div>
            ) : error ? (
              <ErrorState title="Could not load keys" message={error.message} action={<Button variant="outline" size="sm" onClick={() => void reload()}>Try again</Button>} />
            ) : keys.length === 0 ? (
              <div className="rounded-[4px] border border-line-2"><EmptyState title="No keys yet" description="Create a key above to connect your first agent." /></div>
            ) : (
              <TableWrap>
                <table className={`${tableCls} min-w-[720px]`}>
                  <thead><tr><Th>Name</Th><Th>Prefix</Th><Th>Created</Th><Th>Last used</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                  <tbody>{keys.map((k) => <KeyRow key={k.id} k={k} onChanged={() => void reload()} />)}</tbody>
                </table>
              </TableWrap>
            )}
          </section>
        </>
      )}
    </div>
  );
}
