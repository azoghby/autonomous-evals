"use client";
import { createRealtimeClient, type RealtimeClient, type SealedLiveQuery } from "@neon/realtime/client";

/** Server payload from the *_/live routes: the Live SQL URL plus one sealed query per key. */
export type LivePayload<K extends string> = { url: string } & Record<K, SealedLiveQuery<Record<string, unknown>>>;

export interface LiveHandlers<K extends string> {
  /** Re-fetch sealed queries (auth is re-checked server-side on every call). */
  fetchSealed: () => Promise<LivePayload<K>>;
  keys: readonly K[];
  /** Fired on every snapshot of any subscription. */
  onRows: (rows: Partial<Record<K, Array<Record<string, unknown>>>>) => void;
  /** All subscriptions reached `live`. */
  onLive: () => void;
  /** Unrecoverable (fetch failed, subscription `error`). Caller should fall back to polling. */
  onFail: (reason: string) => void;
}

const RENEW_EARLY_MS = 10_000;
const RETRY_MS = 1_000;

let shared: { url: string; client: RealtimeClient } | undefined;
function clientFor(url: string): RealtimeClient {
  if (!shared || shared.url !== url) shared = { url, client: createRealtimeClient({ url }) };
  return shared.client;
}

/** Opens sealed subscriptions, renews them before expiry, returns a disposer. Never throws. */
export function connectLive<K extends string>(h: LiveHandlers<K>): () => void {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs: Array<{ key: K; unsubscribe: () => void; renew: (q: SealedLiveQuery<Record<string, unknown>>) => Promise<unknown> }> = [];
  const rows: Partial<Record<K, Array<Record<string, unknown>>>> = {};
  const live = new Set<K>();
  let announced = false;

  const fail = (why: string) => { if (!closed) { dispose(); h.onFail(why); } };
  function dispose() {
    closed = true;
    clearTimeout(timer);
    for (const s of subs) { try { s.unsubscribe(); } catch { /* already closed */ } }
  }

  function scheduleRenew(expiresAt: number, delay?: number) {
    clearTimeout(timer);
    if (closed) return;
    timer = setTimeout(() => void renew(), delay ?? Math.max(0, expiresAt - Date.now() - RENEW_EARLY_MS));
  }
  async function renew() {
    let next: LivePayload<K>;
    try { next = await h.fetchSealed(); } catch { scheduleRenew(0, RETRY_MS); return; }
    if (closed) return;
    scheduleRenew(Math.min(...h.keys.map((k) => next[k].expiresAt)));
    for (const s of subs) s.renew(next[s.key]).catch(() => fail("renew rejected"));
  }

  void (async () => {
    let first: LivePayload<K>;
    try { first = await h.fetchSealed(); } catch (e) { fail(e instanceof Error ? e.message : "fetch failed"); return; }
    if (closed) return;
    const client = clientFor(first.url);
    for (const key of h.keys) {
      const sub = client.subscribe(first[key]);
      subs.push({ key, unsubscribe: () => sub.unsubscribe(), renew: (q) => sub.renew(q) });
      sub.onChange((snap) => {
        if (closed) return;
        if (snap.status === "error") { fail(snap.error?.message ?? "subscription error"); return; }
        if (snap.data) rows[key] = snap.data as Array<Record<string, unknown>>;
        if (snap.status === "live") live.add(key); else live.delete(key);
        h.onRows({ ...rows });
        if (!announced && live.size === h.keys.length) { announced = true; h.onLive(); }
      });
    }
    scheduleRenew(Math.min(...h.keys.map((k) => first[k].expiresAt)));
  })();

  return dispose;
}
