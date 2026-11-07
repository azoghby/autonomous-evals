/**
 * Bounded transcript normalization for Trace Audit.
 *
 * Accepts (≤ 200 KB UTF-8):
 *  - JSON chat arrays (OpenAI `tool_calls` / `tool` messages, Anthropic `tool_use` / `tool_result` blocks)
 *  - JSON objects wrapping such arrays (`messages`, `events`, `steps`, `trace`, `log`, `items`)
 *  - OpenAI Responses items (`function_call` / `function_call_output`)
 *  - JSONL (one JSON object per line)
 *  - plain-text logs with role prefixes (`USER:`, `ASSISTANT:`, `TOOL name(args): result`, ...)
 *
 * Customer content is data. Nothing here evaluates or executes it. All event text is redacted for
 * credentials before it is stored, quoted, or put into a prompt.
 */
import { redactSecrets } from "../../agents/redact";

export const MAX_TRACE_BYTES = 200 * 1024;
export const MAX_SYSTEM_PROMPT_BYTES = 20_000;
export const MAX_EVENTS = 4_000;
const MAX_EVENT_CHARS = 20_000;

export type TraceEventKind = "system" | "user" | "assistant" | "tool_call" | "tool_result" | "note";

/** explicit = structured error field / non-zero exit / is_error / ERROR prefix; pattern = wording only. */
export type ErrorSignal = "explicit" | "pattern" | null;

export interface TraceEvent {
  id: string;
  index: number;
  kind: TraceEventKind;
  text: string;
  toolName: string | null;
  toolCallId: string | null;
  errorSignal: ErrorSignal;
  /** Credentials removed from this event's text. */
  redactions: number;
  source: string;
}

export interface NormalizedTrace {
  format: "json" | "jsonl" | "text";
  bytes: number;
  events: TraceEvent[];
  redactions: number;
  warnings: string[];
}

export class TraceInputError extends Error {
  constructor(
    readonly code: "empty" | "too_large" | "too_many_events" | "no_events",
    message: string,
  ) {
    super(message);
    this.name = "TraceInputError";
  }
}

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------------------

interface RawEvent {
  kind: TraceEventKind;
  text: string;
  toolName?: string | null;
  toolCallId?: string | null;
  explicitError?: boolean;
  source: string;
}

const ERROR_WORDS =
  /\b(error|exception|failed|failure|denied|forbidden|unauthori[sz]ed|timed? ?out|not found|invalid|conflict|traceback|unavailable|refused|rejected)\b/i;

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

/** `{"ok": true}` / `{"success": true}` / exit code 0: wording like "no conflict" is not an error. */
function explicitSuccessIn(value: unknown): boolean {
  const v = parseMaybeJson(value);
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return o.ok === true || o.success === true || o.exit_code === 0 || o.exitCode === 0 || o.returncode === 0;
}

/** Structured error detection on a tool result payload. */
function explicitErrorIn(value: unknown): boolean {
  let v = value;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^(error|err|fatal|exception)\b[:\s]/i.test(t)) return true;
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        v = JSON.parse(t);
      } catch {
        return false;
      }
    } else return false;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.ok === false || o.success === false || o.is_error === true || o.isError === true) return true;
  if (typeof o.error === "string" ? o.error.length > 0 : o.error && typeof o.error === "object") return true;
  for (const k of ["exit_code", "exitCode", "returncode"]) if (typeof o[k] === "number" && o[k] !== 0) return true;
  for (const k of ["status", "status_code", "statusCode"]) if (typeof o[k] === "number" && (o[k] as number) >= 400) return true;
  if (typeof o.status === "string" && /^(error|failed|failure)$/i.test(o.status)) return true;
  return false;
}

function fromContentBlocks(role: string, content: unknown[], source: string, out: RawEvent[]) {
  const texts: string[] = [];
  const flush = () => {
    if (texts.length) out.push({ kind: roleKind(role), text: texts.join("\n"), source });
    texts.length = 0;
  };
  content.forEach((block, j) => {
    if (typeof block === "string") return void texts.push(block);
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    if (b.type === "text" || b.type === "output_text" || b.type === "input_text") texts.push(stringify(b.text));
    else if (b.type === "tool_use") {
      flush();
      out.push({ kind: "tool_call", text: stringify(b.input), toolName: stringify(b.name) || null, toolCallId: stringify(b.id) || null, source: `${source}.content[${j}]` });
    } else if (b.type === "tool_result") {
      flush();
      const inner = Array.isArray(b.content) ? b.content.map((c) => (c && typeof c === "object" ? stringify((c as Record<string, unknown>).text ?? c) : stringify(c))).join("\n") : stringify(b.content);
      out.push({ kind: "tool_result", text: inner, toolCallId: stringify(b.tool_use_id) || null, explicitError: b.is_error === true || explicitErrorIn(inner), source: `${source}.content[${j}]` });
    } else texts.push(stringify(b));
  });
  flush();
}

function roleKind(role: string): TraceEventKind {
  const r = role.toLowerCase();
  if (r === "system" || r === "developer") return "system";
  if (r === "user" || r === "human" || r === "customer") return "user";
  if (r === "assistant" || r === "ai" || r === "agent" || r === "model" || r === "bot") return "assistant";
  if (r === "tool" || r === "function" || r === "tool_result" || r === "observation") return "tool_result";
  return "note";
}

function fromItem(item: unknown, source: string, out: RawEvent[]) {
  if (typeof item === "string") return void out.push({ kind: "note", text: item, source });
  if (!item || typeof item !== "object") return;
  const o = item as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : null;

  // OpenAI Responses API items
  if (type === "function_call") {
    return void out.push({ kind: "tool_call", text: stringify(o.arguments), toolName: stringify(o.name) || null, toolCallId: stringify(o.call_id ?? o.id) || null, source });
  }
  if (type === "function_call_output") {
    const t = stringify(o.output);
    return void out.push({ kind: "tool_result", text: t, toolCallId: stringify(o.call_id) || null, explicitError: explicitErrorIn(o.output), source });
  }
  // Generic event logs
  if (type === "tool_call" || type === "tool_use" || type === "action") {
    return void out.push({ kind: "tool_call", text: stringify(o.arguments ?? o.args ?? o.input ?? o.params), toolName: stringify(o.name ?? o.tool) || null, toolCallId: stringify(o.id ?? o.call_id) || null, source });
  }
  if (type === "tool_result" || type === "observation" || type === "tool_output") {
    const payload = o.output ?? o.result ?? o.content ?? o.error;
    return void out.push({ kind: "tool_result", text: stringify(payload), toolName: stringify(o.name ?? o.tool) || null, toolCallId: stringify(o.tool_call_id ?? o.call_id ?? o.id) || null, explicitError: o.is_error === true || !!o.error || explicitErrorIn(payload), source });
  }

  const role = typeof o.role === "string" ? o.role : type === "message" ? "assistant" : null;
  if (!role) return void out.push({ kind: "note", text: stringify(o), source });

  const kind = roleKind(role);
  if (kind === "tool_result") {
    const t = Array.isArray(o.content) ? o.content.map((c) => stringify((c as Record<string, unknown>)?.text ?? c)).join("\n") : stringify(o.content);
    return void out.push({ kind, text: t, toolName: stringify(o.name) || null, toolCallId: stringify(o.tool_call_id) || null, explicitError: explicitErrorIn(o.content), source });
  }
  if (Array.isArray(o.content)) fromContentBlocks(role, o.content, source, out);
  else if (o.content !== undefined && o.content !== null && stringify(o.content).trim() !== "") out.push({ kind, text: stringify(o.content), source });

  if (Array.isArray(o.tool_calls)) {
    o.tool_calls.forEach((tc, j) => {
      const c = (tc ?? {}) as Record<string, unknown>;
      const fn = (c.function ?? {}) as Record<string, unknown>;
      out.push({ kind: "tool_call", text: stringify(fn.arguments ?? c.arguments ?? c.input), toolName: stringify(fn.name ?? c.name) || null, toolCallId: stringify(c.id) || null, source: `${source}.tool_calls[${j}]` });
    });
  }
}

const WRAPPER_KEYS = ["messages", "events", "steps", "trace", "log", "logs", "items", "transcript", "conversation"];

function fromJson(value: unknown, out: RawEvent[], warnings: string[]) {
  if (Array.isArray(value)) return value.forEach((v, i) => fromItem(v, `[${i}]`, out));
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const k of WRAPPER_KEYS) {
      if (Array.isArray(o[k])) {
        if (typeof o.system === "string") out.push({ kind: "system", text: o.system, source: "system" });
        return (o[k] as unknown[]).forEach((v, i) => fromItem(v, `${k}[${i}]`, out));
      }
    }
    warnings.push("JSON object without a recognized message array; treated as a single event");
    return fromItem(value, "$", out);
  }
  out.push({ kind: "note", text: stringify(value), source: "$" });
}

const TEXT_ROLE = /^\s*(?:\[[^\]]{0,40}\]\s*)?(system|developer|user|human|customer|assistant|ai|agent|bot|tool(?:[ _]call|[ _]result)?|function|observation)\b\s*([^:\n]{0,200}?)\s*:\s?(.*)$/i;
const TOOL_INLINE = /^([A-Za-z0-9_.:-]{1,80})\s*\((.*)\)$/;

function fromText(content: string, out: RawEvent[]) {
  const lines = content.split(/\r?\n/);
  let current: RawEvent | null = null;
  const push = () => {
    if (current && current.text.trim() !== "") out.push(current);
    current = null;
  };
  lines.forEach((line, i) => {
    const m = TEXT_ROLE.exec(line);
    if (!m) {
      if (current) current.text += `\n${line}`;
      else if (line.trim()) current = { kind: "note", text: line, source: `line ${i + 1}` };
      return;
    }
    push();
    const roleWord = m[1]!.toLowerCase().replace(/[ _]/g, "");
    const qualifier = (m[2] ?? "").trim();
    const rest = m[3] ?? "";
    const source = `line ${i + 1}`;
    if (roleWord.startsWith("tool") || roleWord === "function" || roleWord === "observation") {
      const inline = TOOL_INLINE.exec(qualifier);
      if (roleWord === "toolcall") {
        const call = TOOL_INLINE.exec(rest.trim());
        current = { kind: "tool_call", text: call ? call[2]! : rest, toolName: call ? call[1]! : qualifier || null, source };
        return;
      }
      if (inline) {
        // `TOOL cancel_event(evt_9): ERROR permission denied` → a call and its result.
        out.push({ kind: "tool_call", text: inline[2]!, toolName: inline[1]!, source });
        current = { kind: "tool_result", text: rest, toolName: inline[1]!, explicitError: explicitErrorIn(rest), source };
        return;
      }
      current = { kind: "tool_result", text: rest, toolName: qualifier || null, explicitError: explicitErrorIn(rest), source };
      return;
    }
    current = { kind: roleKind(roleWord), text: rest, source };
  });
  push();
}

/**
 * Normalize a customer transcript. Throws TraceInputError for empty/oversized input.
 * Never truncates silently: oversize input is rejected, oversize single events are clipped with a warning.
 */
export function normalizeTrace(content: string, format: "auto" | "json" | "jsonl" | "text" = "auto"): NormalizedTrace {
  const bytes = byteLength(content);
  if (bytes > MAX_TRACE_BYTES) throw new TraceInputError("too_large", `trace is ${bytes} bytes; limit is ${MAX_TRACE_BYTES}`);
  if (content.trim() === "") throw new TraceInputError("empty", "trace is empty");

  const warnings: string[] = [];
  const raw: RawEvent[] = [];
  let detected: NormalizedTrace["format"] = "text";
  const trimmed = content.trim();

  const tryJson = format === "json" || (format === "auto" && (trimmed.startsWith("{") || trimmed.startsWith("[")));
  let parsed = false;
  if (tryJson) {
    try {
      fromJson(JSON.parse(trimmed), raw, warnings);
      detected = "json";
      parsed = true;
    } catch {
      if (format === "json") warnings.push("declared JSON did not parse; fell back to text/JSONL");
    }
  }
  if (!parsed && (format === "jsonl" || format === "auto" || format === "json")) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    const objs: unknown[] = [];
    let ok = lines.length > 1;
    for (const l of lines) {
      try {
        objs.push(JSON.parse(l));
      } catch {
        ok = false;
        break;
      }
    }
    if (ok) {
      objs.forEach((o, i) => fromItem(o, `line ${i + 1}`, raw));
      detected = "jsonl";
      parsed = true;
    }
  }
  if (!parsed) fromText(content, raw);

  if (raw.length > MAX_EVENTS) throw new TraceInputError("too_many_events", `trace has ${raw.length} events; limit is ${MAX_EVENTS}`);

  // Backfill tool names on results from their calls.
  const nameById = new Map<string, string>();
  for (const r of raw) if (r.kind === "tool_call" && r.toolCallId && r.toolName) nameById.set(r.toolCallId, r.toolName);

  let redactions = 0;
  const events: TraceEvent[] = raw
    .filter((r) => r.text.trim() !== "" || r.kind === "tool_call")
    .map((r, index) => {
      let text = r.text;
      if (text.length > MAX_EVENT_CHARS) {
        warnings.push(`event ${index + 1} clipped to ${MAX_EVENT_CHARS} characters`);
        text = `${text.slice(0, MAX_EVENT_CHARS)}…[clipped]`;
      }
      const red = redactSecrets(text);
      redactions += red.redactions;
      const toolName = r.toolName ?? (r.toolCallId ? nameById.get(r.toolCallId) ?? null : null);
      const errorSignal: ErrorSignal =
        r.kind !== "tool_result"
          ? null
          : r.explicitError
            ? "explicit"
            : !explicitSuccessIn(r.text) && ERROR_WORDS.test(red.text)
              ? "pattern"
              : null;
      return {
        id: `e${index + 1}`,
        index,
        kind: r.kind,
        text: red.text,
        toolName,
        toolCallId: r.toolCallId ?? null,
        errorSignal,
        redactions: red.redactions,
        source: r.source,
      };
    });

  if (events.length === 0) throw new TraceInputError("no_events", "no readable events in trace");
  if (!events.some((e) => e.kind === "assistant")) warnings.push("no assistant messages found; claims cannot be checked");
  return { format: detected, bytes, events, redactions, warnings };
}

/** Redact and bound the customer's system prompt (instructions under test). */
export function normalizeInstructions(systemPrompt: string | null | undefined): { text: string | null; redactions: number; clipped: boolean } {
  if (!systemPrompt?.trim()) return { text: null, redactions: 0, clipped: false };
  let text = systemPrompt;
  let clipped = false;
  while (byteLength(text) > MAX_SYSTEM_PROMPT_BYTES) {
    text = text.slice(0, Math.floor(text.length * 0.9));
    clipped = true;
  }
  const red = redactSecrets(text);
  return { text: red.text, redactions: red.redactions, clipped };
}
