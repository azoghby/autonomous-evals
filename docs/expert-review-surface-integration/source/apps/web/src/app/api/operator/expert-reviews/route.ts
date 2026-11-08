import { getExpertReviewQueue } from '@/server/expert-review';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return getExpertReviewQueue(request); }
