"use client";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { api, errMsg, when } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import { Button, Chip, EmptyState, ErrorState, Field, Spinner } from "@/components/ui";

const FALLBACK_ORIGIN = "https://autonomous-evals.vercel.app";
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

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 pb-2">
        <h3 className="text-sm font-medium text-fg">{label}</h3>
        <CopyButton text={code} label={label} />
      </div>
      <pre tabIndex={0} className="overflow-x-auto border-y border-line py-4 font-mono text-[13px] leading-relaxed text-fg/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        {code}
      </pre>
    </div>
  );
}

function McpSnippets({ origin, apiKey }: { origin: string; apiKey: string }) {
  const url = `${origin}/api/mcp/mcp`;
  const json = JSON.stringify({ mcpServers: { "autonomous-evals": { url, headers: { Authorization: `Bearer ${apiKey}` } } } }, null, 2);
  const cli = `claude mcp add --transport http autonomous-evals ${url} --header "Authorization: Bearer ${apiKey}"`;
  return (
    <div className="space-y-8">
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
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line py-5">
      <div className="min-w-0">
        <div className={revoked ? "font-medium text-subtle line-through decoration-line-strong" : "font-medium text-fg"}>{k.name}</div>
        <div className="mt-0.5 text-xs text-subtle">
          <span className="font-mono">{k.prefix}…</span> · Created {when(k.createdAt)} · {k.lastUsedAt ? `Last used ${when(k.lastUsedAt)}` : "Never used"}
        </div>
        {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <div className="flex items-center gap-2">
        {revoked ? (
          <Chip tone="muted" variant="plain">Revoked</Chip>
        ) : confirming ? (
          <>
            <span className="text-sm text-muted">Revoke this key?</span>
            <Button variant="outline" size="sm" onClick={revoke} disabled={busy} aria-label={`Confirm revoke ${k.name}`}>{busy ? "Revoking…" : "Revoke"}</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label={`Revoke ${k.name}`}>Revoke</Button>
        )}
      </div>
    </li>
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
    <div className="space-y-12">
      <header>
        <h1 className="font-display text-3xl tracking-tight text-fg md:text-4xl">API keys</h1>
        <p className="mt-2 max-w-xl text-muted">Let AI agents hire Autonomous Evals over MCP.</p>
      </header>

      {signedOut ? (
        <p className="border-t border-line pt-6 text-muted">
          You are signed out. <a className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-accent-bright" href="/signin?next=/settings/keys">Sign in</a> to manage API keys.
        </p>
      ) : (
        <>
          <section aria-labelledby="create-key" className="border-t border-line pt-8">
            <h2 id="create-key" className="mb-4 text-lg font-medium text-fg">Create a key</h2>
            <form onSubmit={create} noValidate className="flex max-w-xl flex-col gap-4 sm:flex-row sm:items-start">
              <Field
                id="key-name" label="Name" className="flex-1" placeholder="Claude Code on my laptop" maxLength={80}
                autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} error={nameError ?? undefined}
              />
              <Button type="submit" disabled={creating} className="sm:mt-[1.65rem]">{creating ? "Creating…" : "Create key"}</Button>
            </form>
          </section>

          {created && (
            <section aria-labelledby="new-key" className="space-y-8 border-y border-line-strong py-8">
              <div>
                <h2 id="new-key" className="text-lg font-medium text-fg">Your new key: {created.name}</h2>
                <p role="status" className="mt-1 text-sm text-warn">Copy it now. This key will not be shown again.</p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-bg-raised px-4 py-3 font-mono text-sm text-fg select-all">{created.key}</code>
                  <CopyButton text={created.key} label="API key" />
                </div>
              </div>
              <McpSnippets origin={origin} apiKey={created.key} />
              <Button variant="quiet" onClick={() => setCreated(null)}>I have saved my key</Button>
            </section>
          )}

          {!created && (
            <section aria-labelledby="connect" className="space-y-6">
              <h2 id="connect" className="text-lg font-medium text-fg">Connect an agent</h2>
              <McpSnippets origin={origin} apiKey={PLACEHOLDER_KEY} />
            </section>
          )}

          <section aria-labelledby="your-keys">
            <h2 id="your-keys" className="mb-2 text-lg font-medium text-fg">Your keys</h2>
            {loading ? (
              <div className="flex items-center gap-3 border-t border-line py-8 text-sm text-muted"><Spinner size={16} /> Loading keys…</div>
            ) : error ? (
              <ErrorState title="Could not load keys" message={error.message} action={<Button variant="outline" size="sm" onClick={() => void reload()}>Try again</Button>} />
            ) : keys.length === 0 ? (
              <EmptyState title="No keys yet" description="Create a key above to connect your first agent." />
            ) : (
              <ul className="border-t border-line">
                {keys.map((k) => <KeyRow key={k.id} k={k} onChanged={() => void reload()} />)}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
