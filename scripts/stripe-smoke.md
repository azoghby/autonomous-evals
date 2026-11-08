# Stripe test-mode smoke checklist

Prereq: `STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-setup.ts` done, then redeployed
(`vercel deploy --prod --yes --scope agents-db31`). `STRIPE_MODE=test` everywhere. Use test data only.
Let `APP=https://autonomous-evals.vercel.app`, `CRON_SECRET` from `.env`.

## 1. Valid webhook + real checkout (PLAN §9 Payments: valid webhook)
1. Create a Trace Audit job, accept the quote, open the Checkout link.
2. Pay with card `4242 4242 4242 4242`, any future expiry, any CVC/ZIP.
3. Expect: Stripe dashboard (test) > Developers > Webhooks shows `checkout.session.completed` 200;
   `payments` row inserted; job leaves "awaiting payment" and the workflow resumes.
4. Monitoring tier: pay the $49/mo subscription checkout the same way; expect a
   `monitoring_subscriptions` row (`status=active`, `environment=test`).

## 2. Bad signature rejected (Payments: bad signature rejected)
```
curl -si -X POST $APP/api/stripe/webhook -H 'stripe-signature: t=1,v1=bad' -d '{}'   # expect 400
curl -si -X POST $APP/api/stripe/webhook -d '{}'                                      # expect 400 (missing header)
```

## 3. Duplicate webhook does not create a second job (Payments: duplicate)
1. Find the event id (`evt_...`) in the dashboard (or `stripe events list --limit 3`).
2. Resend: `stripe events resend evt_... --webhook-endpoint we_...` (or dashboard > event > Resend).
3. Expect 200 with `duplicate: true`; still exactly one `payments` row and one job/workflow run for that session.

## 4. Missed webhook recovered by cron (Payments: missed webhook recovered)
1. Dashboard > Webhooks > the endpoint > Disable (or `stripe webhook_endpoints update we_... --disabled`).
2. Run a new checkout with card 4242; confirm NO payment row appears and the job stays awaiting payment.
3. Run the reconciler:
   ```
   curl -s -H "Authorization: Bearer $CRON_SECRET" $APP/api/cron/reconcile-payments
   ```
   Expect 200 summary showing the payment recovered; job resumes. Re-run: nothing new (idempotent).
4. Re-enable the endpoint afterwards.
5. Negative: same curl without the Bearer header must be 401/403.

## 5. Mode guard
- With `STRIPE_MODE=test`, a live-key event (`livemode: true`) is ignored (`environment_mismatch`).
- `stripe-setup.ts` with an `sk_live_` key must refuse without `--live` and `STRIPE_MODE=live`.

## Sign-off
All of 1-4 pass, plus PLAN §9 Durability/Security/Budgets gates, before setting `STRIPE_MODE=live`
and taking real money.
