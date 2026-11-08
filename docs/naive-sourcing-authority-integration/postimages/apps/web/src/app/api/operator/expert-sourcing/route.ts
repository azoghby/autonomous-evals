import { createExpertSourcingApi, withSourcingApiResponse } from "@/server/expert-sourcing-api";
import { sourcingApiDependencies } from "@/server/expert-sourcing-runtime-dependencies";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return withSourcingApiResponse(async () => createExpertSourcingApi(sourcingApiDependencies()).operatorGet(request));
}
export async function POST(request: Request) {
  return withSourcingApiResponse(async () => createExpertSourcingApi(sourcingApiDependencies()).operatorPost(request));
}
