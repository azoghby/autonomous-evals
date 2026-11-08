import { createExpertSourcingApi, withSourcingApiResponse } from "@/server/expert-sourcing-api";
import { sourcingApiDependencies } from "@/server/expert-sourcing-runtime-dependencies";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  return withSourcingApiResponse(async () => createExpertSourcingApi(sourcingApiDependencies()).customerGet(request, (await context.params).jobId));
}
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  return withSourcingApiResponse(async () => createExpertSourcingApi(sourcingApiDependencies()).customerPost(request, (await context.params).jobId));
}
