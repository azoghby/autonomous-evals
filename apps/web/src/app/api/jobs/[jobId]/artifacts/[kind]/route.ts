import { jsonError } from "@/server/http";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";
import { getJob } from "@/server/job-store";
import { readJobArtifact } from "@ae/core/storage/blob";

const KINDS = { report: "reportBlobPath", suite: "suiteBlobPath" } as const;

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string; kind: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId, kind } = await ctx.params;
  if (kind !== "report" && kind !== "suite" && kind !== "evidence") return jsonError(404, "Unknown artifact");
  // Ownership check (operators may view all). 404 hides existence.
  const data = await getJobForViewer(jobId, me);
  if (!data) return jsonError(404, "Job not found");
  const job = await getJob(jobId);
  let path: string | null | undefined;
  if (kind === "evidence") {
    // Evidence is bundled with the report artifact until Track B supplies a separate bundle.
    path = job?.reportBlobPath;
  } else {
    path = job?.[KINDS[kind]];
  }
  if (!path) return jsonError(404, "Artifact not available yet");
  const art = await readJobArtifact(path);
  if (!art) return jsonError(404, "Artifact not found");
  const ext = path.split(".").pop() ?? "bin";
  return new Response(art.stream, {
    headers: {
      "Content-Type": art.contentType,
      "Content-Length": String(art.size),
      "Content-Disposition": `attachment; filename="${kind}-${jobId.slice(0, 8)}.${ext.replace(/[^a-z0-9]/gi, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
