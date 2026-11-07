import type { IntakeInput } from "@ae/core/contracts/index";

/** Credential slots: one per EndpointConfig in the intake. */
export type CredentialMap = Record<string, string>;

/** Inline trace limit; larger traces go to private Blob. */
export const INLINE_TRACE_BYTES = 20 * 1024;

type Json = Record<string, unknown>;
const ENDPOINT_SLOTS = ["endpoint", "endpointA", "endpointB"] as const;

/** Returns the intake with every apiKey removed, plus the extracted keys. Does not mutate the input. */
export function stripCredentials(intake: IntakeInput): { sanitized: Json; credentials: CredentialMap } {
  const sanitized: Json = { ...(intake as unknown as Json) };
  const credentials: CredentialMap = {};
  for (const slot of ENDPOINT_SLOTS) {
    const ep = sanitized[slot] as Json | undefined;
    if (!ep) continue;
    const { apiKey, ...rest } = ep;
    if (typeof apiKey === "string" && apiKey) credentials[slot] = apiKey;
    sanitized[slot] = rest;
  }
  const slots = Object.keys(credentials);
  if (slots.length) sanitized._credentialSlots = slots;
  return { sanitized, credentials };
}

/** Re-injects keys into a stored (sanitized) intake. */
export function injectCredentials(stored: Json, credentials: CredentialMap): Json {
  const out: Json = { ...stored };
  for (const [slot, apiKey] of Object.entries(credentials)) {
    if (out[slot]) out[slot] = { ...(out[slot] as Json), apiKey };
  }
  return out;
}

/** Splits an oversized trace out of the intake. Returns the trace text to upload, if any. */
export function extractLargeTrace(sanitized: Json): { intake: Json; trace: string | null } {
  const trace = sanitized.trace;
  if (typeof trace !== "string" || Buffer.byteLength(trace) <= INLINE_TRACE_BYTES) return { intake: sanitized, trace: null };
  const { trace: _omit, ...rest } = sanitized;
  void _omit;
  return { intake: rest, trace };
}

/** Slots that had an API key at intake (so a missing credentials row means it was deleted, not never provided). */
export function credentialSlotsOf(stored: Json): string[] {
  const v = stored._credentialSlots;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface IntakeSummary {
  package: string;
  notes?: string;
  hasTrace: boolean;
  traceBytes?: number;
  endpointHost?: string;
  model?: string;
  mode?: string;
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try { return new URL(url).host; } catch { return undefined; }
}

/** Safe, client-facing view of a stored intake: no keys, no trace body. */
export function summarizeIntake(
  intake: unknown, jobPackage: string, traceBlobPath?: string | null,
): IntakeSummary {
  const i = (intake && typeof intake === "object" ? intake : {}) as Json;
  const inlineTrace = typeof i.trace === "string" ? i.trace : null;
  const ep = (i.endpoint ?? i.endpointA) as Json | undefined;
  const hasTrace = inlineTrace !== null || !!traceBlobPath;
  return {
    package: typeof i.package === "string" ? i.package : jobPackage,
    ...(typeof i.notes === "string" && i.notes ? { notes: i.notes } : {}),
    hasTrace,
    ...(inlineTrace !== null ? { traceBytes: Buffer.byteLength(inlineTrace) } : {}),
    ...(ep && hostOf(ep.url) ? { endpointHost: hostOf(ep.url) } : {}),
    ...(ep && typeof ep.model === "string" ? { model: ep.model } : {}),
    ...(typeof i.mode === "string" ? { mode: i.mode } : {}),
  };
}
