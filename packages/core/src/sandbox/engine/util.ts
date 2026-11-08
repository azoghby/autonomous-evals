/** Small pure helpers shared across the engine. */
import { createHash } from "node:crypto";
import type { GatewayContext } from "../../ai/gateway";

/** JSON.stringify with sorted object keys (stable hashes). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function shortHash(text: string, len = 10): string {
  return sha256(text).slice(0, len);
}
export function hashOf(value: unknown): string {
  return sha256(stableStringify(value));
}

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Deterministic canary token for a scenario (lower-case, matches /ae_canary_[a-f0-9]{10}/). */
export function canaryFor(seed: string): string {
  return `ae_canary_${shortHash(`canary:${seed}`)}`;
}
export const CANARY_RE = /ae_canary_[a-f0-9]{10}/g;
export function extractCanaries(text: string): string[] {
  return [...new Set(text.match(CANARY_RE) ?? [])];
}

/** Wilson score interval (95% by default). n = 0 → [0, 1]. */
export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): [number, number] {
  if (n <= 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [successes === 0 ? 0 : Math.max(0, center - half), successes >= n ? 1 : Math.min(1, center + half)];
}

/** Bounded-concurrency map preserving input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Budget-tracking ctx: remaining budget shrinks as costs are recorded, so the gateway refuses once exhausted. */
export function budgetContext(
  base: Pick<GatewayContext, "recordCost">,
  budgetMicroUsd: number,
): GatewayContext & { readonly budgetMicroUsd: number; spentMicroUsd(): number } {
  let spent = 0;
  return {
    get budgetMicroUsd() { return Math.max(0, budgetMicroUsd - spent); },
    async recordCost(entry) {
      spent += entry.microUsd;
      await base.recordCost(entry);
    },
    spentMicroUsd: () => spent,
  };
}

/** Replaces every occurrence of each secret with [redacted]. */
export function scrubber(...secrets: Array<string | undefined>): (s: string) => string {
  const list = secrets.filter((s): s is string => Boolean(s && s.length >= 4));
  return (s) => list.reduce((acc, sec) => acc.split(sec).join("[redacted]"), s);
}

/** Table names declared in DDL (CREATE TABLE [IF NOT EXISTS] [schema.]name). */
export function tablesInDdl(ddl: string): string[] {
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  return [...new Set([...ddl.matchAll(re)].map((m) => m[1]!.toLowerCase()))];
}

/** Seeded PRNG (mulberry32) for deterministic perturbations. */
export function rng(seed: string): () => number {
  let a = Number.parseInt(shortHash(seed, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function safeJson(value: unknown, max = 8_000): string {
  let s: string;
  try { s = typeof value === "string" ? value : JSON.stringify(value) ?? "null"; } catch { s = String(value); }
  return clip(s, max);
}
