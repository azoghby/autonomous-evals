import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/*
 * SSRF guard for user-supplied target URLs.
 *
 * `rejectTargetUrl` is the sync, no-DNS check. `assertPublicTarget` adds a DNS resolution check on top.
 *
 * IMPORTANT (Track B HTTP client): a resolve-then-fetch check is only advisory. A hostname can resolve to a
 * public IP here and a private IP when the real client connects (DNS rebinding / TOCTOU). The real HTTP client
 * MUST resolve the host itself, validate every address with `isPrivateAddress`, and PIN the connection to the
 * validated IP for that request (e.g. an undici/https Agent with a custom `connect.lookup`, keeping SNI/Host
 * as the original hostname) so the connect-time address is the one that was checked. Re-validate on redirects.
 */

const DNS_TIMEOUT_MS = 3000;

type Family = 4 | 6;
type Cidr = { readonly base: bigint; readonly bits: number; readonly family: Family };

function parseV4(s: string): bigint | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = BigInt(0);
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n << BigInt(8)) | BigInt(o);
  }
  return n;
}

function parseV6(input: string): bigint | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded dotted IPv4 tail -> two hextets.
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >> BigInt(16)).toString(16)}:${(v4 & BigInt(0xffff)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (p: string) => (p === "" ? [] : p.split(":"));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return n;
}

function cidr4(text: string): Cidr {
  const [ip, bits] = text.split("/");
  return { base: parseV4(ip) as bigint, bits: Number(bits), family: 4 };
}
function cidr6(text: string): Cidr {
  const [ip, bits] = text.split("/");
  return { base: parseV6(ip) as bigint, bits: Number(bits), family: 6 };
}

function inCidr(value: bigint, c: Cidr): boolean {
  const width = c.family === 4 ? 32 : 128;
  const shift = BigInt(width - c.bits);
  return value >> shift === c.base >> shift;
}

const BLOCKED_V4: readonly Cidr[] = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4",
].map(cidr4);

const BLOCKED_V6: readonly Cidr[] = [
  "::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "100::/64", "2001:db8::/32",
].map(cidr6);

const V4_MAPPED = cidr6("::ffff:0:0/96");
const V4_COMPAT = cidr6("::/96"); // deprecated IPv4-compatible (::a.b.c.d)
const NAT64 = cidr6("64:ff9b::/96");
const SIX_TO_FOUR = cidr6("2002::/16");

function isPrivateV4Int(v: bigint): boolean {
  return BLOCKED_V4.some((c) => inCidr(v, c));
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved, unique-local and v4-embedding-private addresses. Unparseable input is treated as private (fail closed). */
export function isPrivateAddress(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) {
    const v = parseV4(host);
    return v === null || isPrivateV4Int(v);
  }
  if (family === 6) {
    const v = parseV6(host);
    if (v === null) return true;
    if (BLOCKED_V6.some((c) => inCidr(v, c))) return true;
    if (inCidr(v, V4_MAPPED) || inCidr(v, NAT64) || inCidr(v, V4_COMPAT)) return isPrivateV4Int(v & BigInt(0xffffffff));
    if (inCidr(v, SIX_TO_FOUR)) return isPrivateV4Int((v >> BigInt(80)) & BigInt(0xffffffff));
    return false;
  }
  return true;
}

/** URL guard (no DNS, no network): HTTPS only; no userinfo; rejects localhost and private/link-local IP literals. Returns a reason or null. */
export function rejectTargetUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "invalid URL"; }
  if (u.protocol !== "https:") return "endpoint must use HTTPS";
  if (u.username || u.password) return "credentials in URL not allowed";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "private host not allowed";
  if (isIP(host) && isPrivateAddress(host)) return "private address not allowed";
  return null;
}

export type LookupResult = ReadonlyArray<{ address: string; family: number }>;
export type LookupFn = (hostname: string) => Promise<LookupResult>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

async function resolveWithTimeout(lookup: LookupFn, hostname: string, timeoutMs: number): Promise<LookupResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([lookup(hostname), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Sync checks plus DNS: resolves all A/AAAA records and rejects if ANY is non-public (or resolution fails/times out).
 * Returns a reason string, or null when the target looks public. See the file header: the real client must also pin the IP.
 */
export async function assertPublicTarget(
  raw: string,
  opts: { lookup?: LookupFn; timeoutMs?: number } = {},
): Promise<string | null> {
  const syncReason = rejectTargetUrl(raw);
  if (syncReason) return syncReason;
  const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) return null; // literal already validated above
  let addrs: LookupResult;
  try {
    addrs = await resolveWithTimeout(opts.lookup ?? defaultLookup, host, opts.timeoutMs ?? DNS_TIMEOUT_MS);
  } catch (e) {
    return e instanceof Error && e.message === "timeout" ? "DNS resolution timed out" : "DNS resolution failed";
  }
  if (addrs.length === 0) return "DNS resolution returned no addresses";
  if (addrs.some((a) => isPrivateAddress(a.address))) return "host resolves to a private address";
  return null;
}
