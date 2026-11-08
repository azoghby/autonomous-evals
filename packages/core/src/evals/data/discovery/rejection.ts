import type { DiscoveryRejection, DiscoveryRejectionReason } from '../acquisition';

const allowed: readonly DiscoveryRejectionReason[] = ['invalid_response', 'content_limit_exceeded', 'pii_detected', 'secret_detected', 'unsafe_data'];
/** Fixed diagnostics only: no source identifiers, content, exception text or matched PII. */
export function validateDiscoveryRejection(value: unknown): DiscoveryRejection {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).join(',') !== 'reasons') throw new Error('public_discovery_invalid_rejection');
  const reasons = (value as DiscoveryRejection).reasons;
  if (!Array.isArray(reasons) || !reasons.length || reasons.length > allowed.length
    || reasons.some(code => !allowed.includes(code)) || new Set(reasons).size !== reasons.length) {
    throw new Error('public_discovery_invalid_rejection');
  }
  return { reasons: [...reasons] };
}
