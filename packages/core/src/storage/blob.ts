import { put, get } from "@vercel/blob";
import { neonPut, neonGet, neonDelete, neonStorageConfigFromEnv } from "./neon-storage";
import { randomBytes } from "node:crypto";

export type ArtifactKind = "report" | "suite" | "evidence" | "trace";

const EXT: Record<string, string> = {
  "text/markdown": "md", "application/json": "json", "text/html": "html", "text/plain": "txt",
};

/** Persisted pathnames are self-describing: `neon:<key>` or `blob:<pathname>`. Unprefixed legacy values are Vercel Blob. */
export const NEON_PREFIX = "neon:";
export const BLOB_PREFIX = "blob:";
export type ArtifactBackend = "neon" | "blob";

/** ARTIFACT_STORE=neon|blob wins; otherwise neon when NEON_STORAGE_* is complete, else blob. */
export function selectBackend(env: Record<string, string | undefined> = process.env): ArtifactBackend {
  const forced = env.ARTIFACT_STORE?.trim().toLowerCase();
  if (forced === "neon" || forced === "blob") return forced;
  return neonStorageConfigFromEnv(env) ? "neon" : "blob";
}

export function parsePathname(p: string): { backend: ArtifactBackend; key: string } {
  if (p.startsWith(NEON_PREFIX)) return { backend: "neon", key: p.slice(NEON_PREFIX.length) };
  if (p.startsWith(BLOB_PREFIX)) return { backend: "blob", key: p.slice(BLOB_PREFIX.length) };
  return { backend: "blob", key: p };
}

/** Stores into the PRIVATE store. Returns the prefixed pathname (persist this, never a URL). */
export async function putJobArtifact(
  jobId: string, kind: ArtifactKind | (string & {}), content: string | Uint8Array | Buffer, contentType = "application/json",
): Promise<string> {
  const ext = EXT[contentType] ?? "bin";
  if (selectBackend() === "neon") {
    const key = `jobs/${jobId}/${kind}-${randomBytes(6).toString("hex")}.${ext}`;
    await neonPut(key, content, contentType);
    return NEON_PREFIX + key;
  }
  const body = typeof content === "string" ? content : Buffer.from(content);
  const res = await put(`jobs/${jobId}/${kind}.${ext}`, body, {
    access: "private", contentType, addRandomSuffix: true, allowOverwrite: false,
  });
  return BLOB_PREFIX + res.pathname;
}

export interface ArtifactStream { stream: ReadableStream<Uint8Array>; contentType: string; size: number }

/** Server-side authenticated read. Never hand out store URLs; stream through an authorized route. */
export async function readJobArtifact(pathname: string): Promise<ArtifactStream | null> {
  const { backend, key } = parsePathname(pathname);
  if (backend === "neon") return neonGet(key);
  const res = await get(key, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) return null;
  return { stream: res.stream, contentType: res.blob.contentType, size: res.blob.size };
}

export async function readJobArtifactText(pathname: string): Promise<string | null> {
  const a = await readJobArtifact(pathname);
  if (!a) return null;
  return new Response(a.stream).text();
}

/** Neon-only delete (Blob artifacts are retained by the existing lifecycle). */
export async function deleteJobArtifact(pathname: string): Promise<void> {
  const { backend, key } = parsePathname(pathname);
  if (backend === "neon") await neonDelete(key);
}
