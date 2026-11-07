/**
 * Credential scrubbing for anything that may reach an agent prompt, a log line, or a report.
 * Pattern-based redaction is a safety net, not a guarantee: callers that know a secret
 * (for example a decrypted target API key) must also pass it as `knownSecrets`.
 */
import type { Logger } from "../evals/types";

const REDACTED = "[REDACTED]";

/** Ordered: specific token shapes first, generic key=value shapes last. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; group?: number }> = [
  { name: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai_key", re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { name: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "stripe_webhook_secret", re: /\bwhsec_[A-Za-z0-9]{16,}/g },
  { name: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "postgres_url_password", re: /\b(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+(@)/gi },
  { name: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, group: 1 },
  {
    name: "auth_header",
    re: /("?(?:authorization|x-api-key|api-key|cookie|set-cookie)"?\s*[:=]\s*"?)([^"\n,}]{6,})/gi,
    group: 1,
  },
  {
    name: "key_value_secret",
    re: /("?\b(?:api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token|private[_-]?key)\b"?\s*[:=]\s*"?)([^"\s,}]{4,})/gi,
    group: 1,
  },
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

  for (const secret of knownSecrets) {
    if (secret.length < 4) continue;
    const parts = text.split(secret);
    if (parts.length > 1) {
      redactions += parts.length - 1;
      kinds.add("known_secret");
      text = parts.join(REDACTED);
    }
  }

  for (const { name, re, group } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, (...args: unknown[]) => {
      redactions += 1;
      kinds.add(name);
      if (name === "postgres_url_password") return `${String(args[1])}${REDACTED}${String(args[2])}`;
      return group ? `${String(args[group])}${REDACTED}` : REDACTED;
    });
  }
  return { text, redactions, kinds: [...kinds] };
}

/** True when the text still contains a known secret or a recognizable credential. */
export function containsSecret(text: string, knownSecrets: readonly string[] = []): boolean {
  if (knownSecrets.some((s) => s.length >= 4 && text.includes(s))) return true;
  return redactSecrets(text).redactions > 0;
}

/** Deep-redacts strings inside JSON-like values (for log payloads). Bounded depth and size. */
export function redactValue(value: unknown, knownSecrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") {
    const clipped = value.length > 2_000 ? `${value.slice(0, 2_000)}…[truncated]` : value;
    return redactSecrets(clipped, knownSecrets).text;
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
