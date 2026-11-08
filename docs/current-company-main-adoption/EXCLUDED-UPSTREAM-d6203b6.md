# Explicit delta from stable adoption pin

This artifact freezes `3f0bd8a589101c9902ad50d402b7948b6dee4c68`; it does **not** adopt
`d6203b61e157df3558e7d6a7df2d8637d82f821d`. The parent orchestrator accepted this earlier-pin
plus delta handoff. The JSON companion binds every changed upstream path and blob ID.

Excluded: founder approval/notification platform and Telegram/WhatsApp/email settings,
email reply/thread authentication, operator notification UI, daily founder report,
migrations0019/0020 plus registry snapshots, marketing team section, and demo shim
safety-block scoring. No channel, approval or email settings were configured here.

The important Stripe delta is the `notifyPlanPurchase` hook: after a newly inserted
plan/audit purchase, it receives sessionId/kind/product/amount/environment/email. It
retains the owner plan/subscription handling and existing audit alert. This hook is
NOT in this earlier candidate. Never replace a newer webhook with this earlier postimage.
Recompose against the newer immutable pin, retain the hook and approval settings,
then rerun whole-source preservation/types/tests/build before claiming newer adoption.

The stager rejects changed/extra owner bytes, including the newer webhook, approval
routes/settings and migrations. SQL002 in this candidate is the separate payment
recovery correction; it does not adopt or supersede platform migrations0019/0020.
Genuine owner adapters and release acceptance remain blocked. No migration, provider,
message, outreach or deployment was performed.
