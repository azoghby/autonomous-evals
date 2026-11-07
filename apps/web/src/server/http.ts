import "server-only";
import { z } from "zod";
import { getCurrentCustomer } from "./session";
import type { Viewer } from "./access";

export const jsonError = (status: number, error: string, extra?: Record<string, unknown>) =>
  Response.json({ error, ...extra }, { status });

export async function readJson<S extends z.ZodType>(req: Request, schema: S):
  Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  let raw: unknown;
  try { raw = await req.json(); } catch { return { ok: false, res: jsonError(400, "Invalid JSON body") }; }
  const parsed = schema.safeParse(raw);
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
