import type { ProviderReceiptAdapter } from './index';

/** Offline capability inventory, NOT billing proof. The installed managed-agents SDK
 * exposes credits.ledger({session_id,agent_id,...}) and priced debit rows, but those
 * rows do not authenticate this remediation operation's input digest, external target
 * request and observed token identity. AI token usage alone is not a USD receipt.
 * A provider-specific independently authenticated mapping is still required. */
export const INSTALLED_PROVIDER_RECEIPT_GATE = Object.freeze({
  provider: '@usenaive-sdk/managed-agents',
  inspectedVersion: '0.12.3',
  capability: 'unavailable' as const,
  reason: 'No demonstrated authoritative priced receipt binding remediation operation/input/request/usage identity.',
});

/** Fail-closed actual composition until a reviewed provider adapter exists.
 * This performs no SDK, network, credential or target calls and never creates receipts. */
export function unavailableProviderReceiptAdapter(provider: string, accountId: string): ProviderReceiptAdapter {
  return Object.freeze({provider,accountId,capability:'unavailable' as const,
    retrieve:async()=>null,authenticate:async()=>false});
}
