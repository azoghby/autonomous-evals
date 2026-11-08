import 'server-only';
import { stripe, webhookSecret, getStripeMode } from '@ae/core/payments/stripe';
import type { BridgeOptions } from './current-payment';

/** Current owner secret accessor and SDK signature verification, evaluated only on webhook ingestion.
 * constructEvent is local cryptographic verification; it sends no Stripe request. */
export function currentStripePaymentOptions(options: Omit<BridgeOptions,'verifyStripe'>): BridgeOptions {
  return {...options,verifyStripe:(raw,signature)=>{
    const event = stripe().webhooks.constructEvent(raw,signature,webhookSecret());
    if (event.livemode !== (getStripeMode() === 'live')) throw new Error('current_payment_configured_environment_mismatch');
    return event;
  }};
}
