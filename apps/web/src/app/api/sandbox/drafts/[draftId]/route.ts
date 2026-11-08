import { jsonError, requireViewer } from "@/server/http";
import { getSandboxService } from "@/server/sandbox-service";

const DRAFT_ID = /^drf_[0-9a-f-]{36}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const { draftId } = await params;
  if (!DRAFT_ID.test(draftId)) return jsonError(404, "Draft not found");
  try {
    const draft = await getSandboxService().getDraft(auth.viewer.id, draftId);
    return draft ? Response.json({ draft }) : jsonError(404, "Draft not found");
  } catch (err) {
    console.error("get sandbox draft failed", err);
    return jsonError(500, "Could not load draft");
  }
}
