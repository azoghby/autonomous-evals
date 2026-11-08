import { linkJobBudgetCost, retainedProxyReservation, type JobBudgetTx } from './job-budget-authority';

/** Called only by the cost sink inside its canonical job transaction, AFTER its
 * immutable receipt validation. No linkage is inferred from equal amounts alone. */
export async function linkRetainedModelReceipt(tx:JobBudgetTx,jobId:string,receiptKey:string) {
  const proxy=/^naive_proxy:req_[0-9a-hjkmnp-tv-z]{26}$/.test(receiptKey);
  if(!proxy&&!/^naive:ses_[0-9a-hjkmnp-tv-z]{26}$/.test(receiptKey))return;
  const installed=(await tx.query<{present:unknown}>("SELECT to_regclass('job_budget.operations') AS present")).rows[0];
  if(!installed?.present)return; // Legacy-only installations have no bridge debit to substitute.
  const sessionId=receiptKey.slice('naive:'.length);
  const ids=new Set<string>();
  if(proxy){const id=await retainedProxyReservation(tx,jobId,receiptKey);if(id)ids.add(id);}else{
  const native=(await tx.query<{reservation_id:string}>(`SELECT record->>'reservationId' AS reservation_id
    FROM agent_persistence.tasks WHERE record->>'jobId'=$1 AND record->>'sessionId'=$2`,[jobId,sessionId])).rows;
  for(const row of native)if(row.reservation_id)ids.add(row.reservation_id);
  const optional=(await tx.query<{present:unknown}>("SELECT to_regclass('naive_copilot.dispatches') AS present")).rows[0];
  if(optional?.present){
    const copilot=(await tx.query<{reservation_id:string}>(`SELECT identity->>'reservationId' AS reservation_id
      FROM naive_copilot.dispatches WHERE identity->'task'->>'jobId'=$1 AND session_id=$2`,[jobId,sessionId])).rows;
    for(const row of copilot)if(row.reservation_id)ids.add(row.reservation_id);
  }
  }
  const operations=[];
  for(const id of ids){
    const rows=(await tx.query<{operation_id:string}>(
      'SELECT operation_id FROM job_budget.operations WHERE job_id=$1 AND agent_reservation_id=$2 AND admitted',[jobId,id])).rows;
    operations.push(...rows);
  }
  if(!operations.length)return; // Unlinked historical usage remains conservatively additive.
  if(operations.length!==1)throw Error('job_budget_receipt_conflict');
  const cost=(await tx.query<{id:string}>(
    "SELECT id FROM costs WHERE job_id=$1 AND source=$3 AND receipt_key=$2",[jobId,receiptKey,proxy?'naive_proxy':'naive'])).rows[0];
  if(!cost)throw Error('job_budget_receipt_conflict');
  await linkJobBudgetCost(tx,{jobId,operationId:operations[0]!.operation_id,costId:cost.id,expectedReceiptKey:receiptKey});
}
