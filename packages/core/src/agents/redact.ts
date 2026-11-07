/**
 * Credential scrubbing for anything that may reach an agent prompt, a log line, or a report.
 * Pattern-based redaction is a safety net, not a guarantee: callers that know a secret
 * (for example a decrypted target API key) must also pass it as `knownSecrets`.
 */
import type { Logger } from "../evals/types";

const REDACTED = "[REDACTED]";

/** Specific token shapes supplement credential assignments and known secrets. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; group?: number }> = [
  { name: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic_key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai_key", re: /sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { name: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "stripe_webhook_secret", re: /\bwhsec_[A-Za-z0-9]{16,}/g },
  { name: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "database_url_password", re: /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+(@)/gi },
  { name: "huggingface_token", re: /\bhf_[A-Za-z0-9]{20,}/g },
  { name: "sendgrid_token", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: "npm_token", re: /\b(?:npm_|napi_)[A-Za-z0-9]{20,}/g },
  { name: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, group: 1 },
];

export interface RedactionResult {
  text: string;
  redactions: number;
  kinds: string[];
}

export function redactSecrets(input: string, knownSecrets: readonly string[] = []): RedactionResult {
  let text = input;
  let redactions = 0;
  const kinds = new Set<string>();

  // JSON event payloads can still contain encoded string values after the outer trace is decoded.
  const variants = new Set(knownSecrets.filter((s) => s.length >= 4).flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]));
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) {
    const parts = text.split(secret);
    if (parts.length > 1) {
      redactions += parts.length - 1;
      kinds.add("known_secret");
      text = parts.join(REDACTED);
    }
  }

  // Capture a complete quoted value (including escaped quotes), or one unquoted assignment.
  // Matching whole keys avoids treating ordinary words such as "tokenizer" as credentials.
  const assignments = /(^|[^A-Za-z0-9_-])(["']?)([A-Za-z][A-Za-z0-9_-]*)\2(\s*[:=]\s*)/g;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const match of text.matchAll(assignments)) {
    const key = match[3]!;
    const sensitive = /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)(?:$|[_-])|(?:password|passwd|secret|token|apiKey|privateKey)$/i.test(key)
      || /^(?:authorization|x-api-key|api-key|cookie|set-cookie)$/i.test(key);
    if (!sensitive) continue;
    const start = match.index + match[0].length;
    if (edits.length && start < edits[edits.length - 1]!.end) continue;
    const valuePattern = /^(?:authorization|x-api-key|api-key|cookie|set-cookie)$/i.test(key) && !/^["']/.test(text.slice(start))
      ? /^[^\r\n,}]+/
      : /^("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}&"']+)/;
    const value = valuePattern.exec(text.slice(start))?.[0];
    if (!value) continue;
    const quoted = value.startsWith('"') || value.startsWith("'");
    const inner = quoted ? value.slice(1, -1) : value;
    if (!inner || inner === REDACTED || /^(?:null|false|true)$/i.test(inner)) continue;
    redactions++;
    kinds.add("key_value_secret");
    edits.push({ start, end: start + value.length, replacement: quoted ? `${value[0]}${REDACTED}${value[0]}` : REDACTED });
  }
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);

  for (const { name, re, group } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, (...args: unknown[]) => {
      const replacement = name === "database_url_password"
        ? `${String(args[1])}${REDACTED}${String(args[2])}`
        : group ? `${String(args[group])}${REDACTED}` : REDACTED;
      if (replacement === args[0]) return replacement;
      redactions += 1;
      kinds.add(name);
      return replacement;
    });
  }
  return { text, redactions, kinds: [...kinds] };
}

/** True when the text still contains a known secret or a recognizable credential. */
export function containsSecret(text: string, knownSecrets: readonly string[] = []): boolean {
  return redactSecrets(text, knownSecrets).redactions > 0;
}

/** Deep-redacts strings inside JSON-like values (for log payloads). Bounded depth and size. */
export function redactValue(value: unknown, knownSecrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") {
    const redacted = redactSecrets(value, knownSecrets).text;
    return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}…[truncated]` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, knownSecrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      out[k] = /api[_-]?key|secret|password|token|authorization|credential/i.test(k)
        ? REDACTED
        : redactValue(v, knownSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

/** Wraps a Logger so every payload is redacted before it is written. */
export function redactingLogger(inner: Logger, knownSecrets: readonly string[] = []): Logger {
  const wrap =
    (fn: Logger["info"]) =>
    (event: string, data?: Record<string, unknown>) =>
      fn(event, data ? (redactValue(data, knownSecrets) as Record<string, unknown>) : undefined);
  return { info: wrap(inner.info), warn: wrap(inner.warn), error: wrap(inner.error) };
}
