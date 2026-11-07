import { putJobArtifact, readJobArtifact, parsePathname } from "../storage/blob";
import type { ArtifactStore } from "../contracts/services";

export const ARTIFACT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export function assertArtifactName(name: string): void {
  if (!ARTIFACT_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`Invalid artifact name "${name}": use lowercase [a-z0-9._-], max 100 chars, no "..".`);
  }
}

export function createArtifactStore(jobId: string): ArtifactStore {
  const prefix = `jobs/${jobId}/`;
  return {
    async put(name, body, contentType) {
      assertArtifactName(name);
      const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
      if (size > MAX_ARTIFACT_BYTES) throw new Error(`Artifact too large (${size} bytes, max ${MAX_ARTIFACT_BYTES}).`);
      return { pathname: await putJobArtifact(jobId, `agent-${name}`, body, contentType) };
    },
    async get(pathname) {
      const { key } = parsePathname(pathname);
      if (!key.startsWith(prefix) || key.split("/").includes("..")) throw new Error("Artifact path is outside this job.");
      const a = await readJobArtifact(pathname);
      if (!a) return null;
      return { body: new Uint8Array(await new Response(a.stream).arrayBuffer()), contentType: a.contentType };
    },
  };
}
