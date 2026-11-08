import { jsonError } from "@/server/http";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";
import { getJob } from "@/server/job-store";
import { readJobArtifact, readJobArtifactText } from "@ae/core/storage/blob";
import { renderReportDocument } from "@/server/report-html";

const KINDS = { report: "reportBlobPath", suite: "suiteBlobPath" } as const;

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
} as const;

export async function GET(req: Request, ctx: { params: Promise<{ jobId: string; kind: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId, kind } = await ctx.params;
  if (kind !== "report" && kind !== "suite" && kind !== "evidence" && kind !== "report-html") return jsonError(404, "Unknown artifact");
  // Ownership check (operators may view all). 404 hides existence.
  const data = await getJobForViewer(jobId, me);
  if (!data) return jsonError(404, "Job not found");
  const job = await getJob(jobId);
  if (kind === "report-html") {
    // The stored report-html key is random-suffixed and not recorded on the job (no list API), so
    // render the stored markdown server-side with an escaping-only renderer.
    if (!job?.reportBlobPath) return jsonError(404, "Artifact not available yet");
    const md = await readJobArtifactText(job.reportBlobPath);
    if (md === null) return jsonError(404, "Artifact not found");
    const download = new URL(req.url).searchParams.get("download") === "1";
    const disp = download ? `attachment; filename="report-${jobId.slice(0, 8)}.html"` : "inline";
    return new Response(renderReportDocument("Report", md), { headers: { ...HTML_HEADERS, "Content-Disposition": disp } });
  }
  let path: string | null | undefined;
  if (kind === "evidence") {
    // Evidence is bundled with the report artifact until Track B supplies a separate bundle.
    path = job?.reportBlobPath;
  } else {
    path = job?.[KINDS[kind as "report" | "suite"]];
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
