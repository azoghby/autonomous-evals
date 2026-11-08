import 'server-only';
import type { CurrentOwnerLoader } from './current-payment-startup';

/** Exact handoff point for the independently reviewed source-policy/provider owner composition.
 * Replace this export with its reviewed loader import, preserving CurrentOwnerLoader's contract.
 * No environment JSON, request body, model output, cookie-global or fabricated provider can fill it.
 * Payment SQL and checkout bridge remain executable independently of this release activation gate. */
export const loadCurrentAutonomyOwner: CurrentOwnerLoader = async () => ({
  status:'blocked',
  missing:[
    'reviewed_owner_source_policy_and_revocation_adapter',
    'pinned_provider_transport_and_retained_receipt_verifier',
    'metered_data_evaluator_and_consented_outbox_adapters',
    'finite_paid_policy_and_current_secret_scanner',
    'durable_canonical_exclusive_dispatch_owner',
  ],
});
