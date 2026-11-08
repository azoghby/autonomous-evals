import { redirect } from 'next/navigation';
import { getCurrentCustomer } from '@/server/session';
import { ExpertReviewQueue } from '@/components/app/expert-review-queue';
import { Empty } from '@/components/app/ui';

export const metadata={title:'Evidence review · Operator · Standard Evals'};
export default async function ExpertReviewsPage() {
 const principal=await getCurrentCustomer();
 if(!principal)redirect('/signin?next=/operator/expert-reviews');
 if(!principal.isOperator)return <Empty title="Operators only" body="Independent evidence review requires an authenticated operator account."/>;
 return <ExpertReviewQueue/>;
}
