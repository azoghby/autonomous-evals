# Monitoring comparison service

`packages/core/src/monitoring/index.ts` exports `frozenSuiteDigest`, `compareMonitoringRuns`, and `monitoringAlertDraft`. It is a pure comparison service; Track A owns subscription eligibility, scheduler authentication, execution dispatch, durable results, and email delivery.

Persist the exact frozen suite serialization and its SHA-256 digest. Give each monitoring execution a new run ID and fresh scenario state. Map engine outcomes into `passed`, `failed`, `inconclusive`, or `infrastructure_error`; never map a timeout to an ordinary failed check. Supply stable scenario/check identities and stored evidence IDs for definitive outcomes.

The comparison rejects different jobs, suites, repeated run IDs, duplicate/missing checks, and definitive results without evidence. Only pass-to-fail transitions count as observed regressions. Unresolved baseline/current checks remain unresolved. Baseline evidence is preserved and never overwritten. The alert helper produces a draft without customer content, endpoint secrets, or outbound delivery.

Validation: eight unit cases pass and strict TypeScript checking passes in the isolated harness. Live scheduling, persistence, provider execution, and delivered notifications remain Track A integration work; this module alone does not implement the monitoring subscription product.
