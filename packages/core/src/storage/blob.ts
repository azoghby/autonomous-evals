import { put, get } from "@vercel/blob";

export type ArtifactKind = "report" | "suite" | "evidence" | "trace";

const EXT: Record<string, string> = {
  "text/markdown": "md", "application/json": "json", "text/html": "html", "text/plain": "txt",
};

/** Stores into the PRIVATE blob store. Returns the pathname (persist this, never a URL). */
export async function putJobArtifact(
  jobId: string, kind: ArtifactKind | (string & {}), content: string | Uint8Array | Buffer, contentType = "application/json",
): Promise<string> {
  const ext = EXT[contentType] ?? "bin";
  const body = typeof content === "string" ? content : Buffer.from(content);
  const res = await put(`jobs/${jobId}/${kind}.${ext}`, body, {
    access: "private", contentType, addRandomSuffix: true, allowOverwrite: false,
  });
  return res.pathname;
}

export interface ArtifactStream { stream: ReadableStream<Uint8Array>; contentType: string; size: number }

/** Server-side authenticated read. Never hand out blob URLs; stream through an authorized route. */
export async function readJobArtifact(pathname: string): Promise<ArtifactStream | null> {
  const res = await get(pathname, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) return null;
  return { stream: res.stream, contentType: res.blob.contentType, size: res.blob.size };
}

export async function readJobArtifactText(pathname: string): Promise<string | null> {
  const a = await readJobArtifact(pathname);
  if (!a) return null;
  return new Response(a.stream).text();
}
