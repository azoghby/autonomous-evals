import { redirect } from 'next/navigation';
import { getCurrentCustomer } from '@/server/session';
import { OperatorExpertSourcing } from '@/components/app/operator-expert-sourcing';
import { Empty } from '@/components/app/ui';

export const metadata={title:'Expert sourcing · Operator · Standard Evals'};
export default async function ExpertReviewsPage() {
 const principal=await getCurrentCustomer();
 if(!principal)redirect('/signin?next=/operator/expert-sourcing');
 if(!principal.isOperator)return <Empty title="Operators only" body="Expert sourcing configuration requires an authenticated operator account."/>;
 return <OperatorExpertSourcing/>;
}
