# Standard Evals

An agent-operated AI evaluation company built with the Naïve SDK, with Stripe checkout in the implementation plan.

Customers submit an AI product, receive an agent-prepared quote, pay through checkout, and receive reproducible findings, an evaluation report, and a reusable test suite.

## Planning

[Implementation plan](PLAN.md) is the working source of truth. Edit it directly on GitHub or propose changes through a pull request.

The plan covers the customer experience, agent responsibilities, evaluation engine, Stripe checkout, stack, build order, and acceptance tests.

## Status

Track B core services are implemented: Naïve agents, Trace Audit, secure targets,
Text and Calendar evaluation, evidence-backed findings/reports, data acquisition,
private progress chat, remediation, and comparison/monitoring components.

Application integration is still in progress. Track A owns the app, payments,
platform and deployment; owner-applyable integration patches are maintained under
`docs/`. Local tests and retained synthetic live probes do not establish deployed
customer acceptance or real payment completion.

See [Track B release status](docs/track-b-release-status.md) for evidence and
remaining gates, and [combined Workflow integration](docs/complete-workflow-integration/README.md)
for the data/remediation handoff. Later chat, pack, monitoring and resume work must
be composed and verified before deployment.

Initial target: the Naïve Autonomous Company Hackathon, November 7–8, 2026.
