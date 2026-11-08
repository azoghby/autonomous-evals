# Inspecting the customer UI and eval chat

Source checked at `11d7ff2` (the subsequent staging receipt commit changes docs only). You do not need the previous orchestrator to identify the implemented screens. This guide describes current repository routes; it is not a claim that the latest source is deployed.

1. Open your intended app deployment at `/signin?next=/evals` and complete its normal email sign-in. Use a non-operator account to see the customer experience. An operator session is not a substitute for customer authorization testing.
2. `/evals` lists that account's sandbox runs and audits. Open an existing evaluation, or choose **Ask** beside it. The link adds `?ask=1` to the evaluation's own URL.
3. On an evaluation page, **Ask about this eval** opens the desktop copilot panel. On mobile, **Ask** opens a bottom sheet. The implemented heading is **Eval copilot**. Current mounts are audit/job pages (`/jobs/<jobId>`) and sandbox run pages (`/sandbox/runs/<runId>`).
4. If the account has no evaluations, `/sandbox/new` opens the customer intake. Starting an actual evaluation may invoke paid models; inspecting the form alone does not create a completed run. `/sandbox/runs/sample` is the labelled sample, not your account's live evaluation or proof of authenticated chat acceptance.
5. To inspect operator functions separately, use an authorized operator account at `/operator`. The new independent contribution/corpus review panel remains an unapplied artifact in `expert-review-surface-integration`; do not expect it in the deployed operator console yet.

## Scout versus the implemented copilot

The approved pixel Scout artwork and historical private progress-chat patch are in `pixel-scout-chat` and `current-company-main-adoption/scout-extension`. These are owner-application artifacts. They are not evidence that the current consumer copilot uses that artwork, that the historical chat is mounted, or that chat runs on Naïve. Preserve the newer actual `apps/web/src/components/eval-chat` implementation rather than applying those old patches blindly.

## What to check

Use an evaluation owned by the signed-in customer. Verify its report and evidence, open/close the panel on desktop and mobile, read an existing conversation, and confirm another customer's evaluation remains inaccessible. Sending a message can invoke the configured chat model; explicitly approving an action can trigger its real behavior. Keep sample/fixture observations separate from real hosted authentication, provider and action receipts.

For local UI-only inspection, an isolated fixture can render actual components with labelled mocked APIs; that proves layout and interactions only. The current root checkout lacks TypeScript/Vitest executables, and the new staging database alone does not provide a hosted app, email sign-in or configured chat provider. Deployment identity and those connections still need verification before calling a walkthrough live acceptance.
