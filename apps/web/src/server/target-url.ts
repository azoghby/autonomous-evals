/** URL guard (no DNS, no network): HTTPS only; rejects localhost and private/link-local IP literals. Returns a reason or null. */
export function rejectTargetUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "invalid URL"; }
  if (u.protocol !== "https:") return "endpoint must use HTTPS";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "private host not allowed";
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private address not allowed";
  }
  if (host.includes(":") && (host === "::1" || host === "::" || /^(fc|fd|fe80)/.test(host) || host.startsWith("::ffff:"))) return "private address not allowed";
  return null;
}
