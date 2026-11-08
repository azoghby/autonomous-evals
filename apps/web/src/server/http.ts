import "server-only";
import { z } from "zod";
import { getCurrentCustomer } from "./session";
import type { Viewer } from "./access";
import { DEFAULT_MAX_BODY_BYTES, readBoundedJson } from "./body-limit";

export const jsonError = (status: number, error: string, extra?: Record<string, unknown>) =>
  Response.json({ error, ...extra }, { status });

/** Parses and validates a JSON body capped at maxBytes (default 256 KB; 413 above it). */
export async function readJson<S extends z.ZodType>(req: Request, schema: S, maxBytes = DEFAULT_MAX_BODY_BYTES):
  Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const body = await readBoundedJson(req, maxBytes);
  if (!body.ok) return body;
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) return { ok: false, res: jsonError(400, "Invalid request", { issues: z.flattenError(parsed.error) }) };
  return { ok: true, data: parsed.data };
}

export async function requireViewer(): Promise<{ viewer: Viewer; res?: undefined } | { viewer?: undefined; res: Response }> {
  const viewer = await getCurrentCustomer();
  return viewer ? { viewer } : { res: jsonError(401, "Authentication required") };
}

export async function requireOperator() {
  const r = await requireViewer();
  if (r.res) return r;
  return r.viewer.isOperator ? r : { res: jsonError(403, "Operator access required") };
}

export const UUID = z.uuid();
export const isUuid = (s: string) => UUID.safeParse(s).success;
