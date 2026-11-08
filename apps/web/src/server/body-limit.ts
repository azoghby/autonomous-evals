/** Bounded request-body reading: Content-Length is checked up front, and the stream is cut off at the cap regardless. */

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyText(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/** Parsed JSON, or a ready error Response (413 too large, 400 invalid JSON). */
export async function readBoundedJson(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  let text: string;
  try { text = await readBodyText(req, maxBytes); } catch (e) {
    if (e instanceof BodyTooLargeError) return { ok: false, res: Response.json({ error: "Request body too large", maxBytes }, { status: 413 }) };
    return { ok: false, res: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, res: Response.json({ error: "Invalid JSON body" }, { status: 400 }) }; }
}
