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
