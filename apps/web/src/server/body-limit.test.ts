import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyText, readBoundedJson } from "./body-limit";

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://x", { method: "POST", body, headers, duplex: "half" } as RequestInit);

/** A stream with no Content-Length that keeps producing 64 KB chunks: must be cut off, not buffered. */
function endless(): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({ pull(c) { sent++; c.enqueue(new Uint8Array(64 * 1024)); if (sent > 10_000) c.close(); } });
}

describe("bounded body reading", () => {
  it("reads a small JSON body", async () => {
    expect(await readBoundedJson(post(JSON.stringify({ a: 1 })))).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects a declared Content-Length over the cap without reading", async () => {
    await expect(readBodyText(post("x", { "content-length": String(10 * 1024 * 1024) }), 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("cuts off a chunked body that grows past the cap", async () => {
    const r = await readBoundedJson(post(endless()), 256 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.res.status).toBe(413);
  });

  it("400 on invalid JSON", async () => {
    const r = await readBoundedJson(post("{nope"));
    expect(!r.ok && r.res.status).toBe(400);
  });
});
