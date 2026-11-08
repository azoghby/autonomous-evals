import { getExpertReview, postExpertReview, type ExpertReviewParams } from '@/server/expert-review';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<ExpertReviewParams> };
export async function GET(_request: Request, context: Context) { return getExpertReview(await context.params); }
export async function POST(request: Request, context: Context) { return postExpertReview(request, await context.params); }
